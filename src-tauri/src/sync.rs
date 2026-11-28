//! 手机互传：电脑开一个临时局域网服务，手机扫码绑定，电脑确认方向后只传变化的书稿。
//!
//! 关键约束：
//! - 只同步用户自己写的内容（书信息、大纲、设定、正文、灵感笔记、封面/图片），
//!   主题、语言、窗口大小、界面折叠状态等本地偏好永远不进入同步包。
//! - 每个文件只保存“最新指纹”（大小、mtime、SHA-256），不存逐字历史。
//! - 一方没有书时按整本传；双方都有书时先比较指纹，默认选更新更多的一方，
//!   电脑端可以手动翻转方向，翻转后再次确认才真正开始。
//! - 进度按实际 HTTP 字节推进，不伪造百分比。

use super::{
    chapters_dir, ensure_dir, ensure_project, load_library, now_ms, sanitize_name, BOOK_FILE,
    LORE_FILE, OUTLINE_FILE, PROOFREAD_FILE,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::net::UdpSocket;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Request, Response, Server, StatusCode};
use zip::read::ZipArchive;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const SYNC_VERSION: u32 = 1;
const TOKEN_TTL_MS: i64 = 10 * 60 * 1000;
const MAX_MANIFEST_FILES: usize = 20_000;

static SESSION: Mutex<Option<Arc<TransferSession>>> = Mutex::new(None);

/* ───────────────────────── 数据结构 ───────────────────────── */

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncFile {
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub mtime: i64,
    pub hash: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncManifest {
    pub version: u32,
    pub book_id: String,
    pub title: String,
    pub author: String,
    pub updated_at: i64,
    pub chapter_count: usize,
    pub total_bytes: u64,
    pub files: Vec<SyncFile>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct IndexEntry {
    size: u64,
    mtime: i64,
    hash: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct SyncIndex {
    version: u32,
    files: BTreeMap<String, IndexEntry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
   pub name: String,
    pub platform: String,
    pub model: String,
    pub app_version: String,
    pub last_seen_at: i64,
    pub manifest: Option<SyncManifest>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompareItem {
    pub path: String,
    pub kind: String,
    pub state: String,
    pub pc_size: u64,
    pub phone_size: u64,
    pub pc_mtime: i64,
    pub phone_mtime: i64,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub pc_files: usize,
    pub phone_files: usize,
    pub pc_bytes: u64,
    pub phone_bytes: u64,
    pub same: usize,
    pub pc_only: usize,
    pub phone_only: usize,
    pub pc_newer: usize,
    pub phone_newer: usize,
    pub conflicts: usize,
    pub changed_pc_to_phone: usize,
    pub changed_phone_to_pc: usize,
    pub changed_bytes_pc_to_phone: u64,
    pub changed_bytes_phone_to_pc: u64,
    pub suggested_direction: String,
    pub confidence: String,
    pub items: Vec<CompareItem>,
}

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub bytes_done: u64,
    pub total_bytes: u64,
    pub percent: f64,
    pub speed: f64,
    pub current_file: String,
    pub files_done: usize,
    pub files_total: usize,
    pub started_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookBrief {
    pub path: Option<String>,
    pub id: String,
    pub title: String,
    pub author: String,
    pub chapters: usize,
    pub bytes: u64,
    pub updated_at: i64,
    pub empty: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferSnapshot {
    pub id: String,
    pub phase: String,
    pub url: String,
    pub host: String,
    pub port: u16,
    pub expires_at: i64,
    pub book: Option<BookBrief>,
    pub device: Option<DeviceInfo>,
    pub direction: String,
    pub comparison: Option<Comparison>,
    pub progress: TransferProgress,
    pub can_confirm: bool,
    pub error: Option<String>,
}

struct ProgressState {
    current_file: String,
    files_done: usize,
    files_total: usize,
    started_at: i64,
}

impl Default for ProgressState {
    fn default() -> Self {
        Self {
            current_file: String::new(),
            files_done: 0,
            files_total: 0,
            started_at: 0,
        }
    }
}

struct TransferSession {
    token: String,
    host: String,
    port: u16,
    expires_at: i64,
    book_path: Mutex<Option<PathBuf>>,
    pc_manifest: Mutex<SyncManifest>,
    phone: Mutex<Option<DeviceInfo>>,
    comparison: Mutex<Option<Comparison>>,
    direction: Mutex<String>,
    phase: Mutex<String>,
    progress_state: Mutex<ProgressState>,
    bytes_done: Arc<AtomicU64>,
    total_bytes: Arc<AtomicU64>,
    sample_at: Arc<AtomicI64>,
    final_speed: Arc<AtomicU64>,
    zip_path: Mutex<Option<PathBuf>>,
    app_data: Mutex<Option<String>>,
    error: Mutex<Option<String>>,
    app: AppHandle,
    server: Arc<Server>,
    stop: AtomicBool,
}

impl TransferSession {
    fn snapshot(&self) -> TransferSnapshot {
        let book = self.pc_manifest.lock().unwrap();
        let device = self.phone.lock().unwrap().clone();
        let comparison = self.comparison.lock().unwrap().clone();
        let phase = self.phase.lock().unwrap().clone();
        let direction = self.direction.lock().unwrap().clone();
        let error = self.error.lock().unwrap().clone();
        let state = self.progress_state.lock().unwrap();
        let bytes = self.bytes_done.load(Ordering::SeqCst);
        let total = self.total_bytes.load(Ordering::SeqCst);
        let percent = if total == 0 {
            if phase == "done" { 100.0 } else { 0.0 }
        } else {
            (bytes as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
        };
        let speed = if bytes > 0 {
            let started = self.sample_at.load(Ordering::SeqCst);
            let avg = if started > 0 && now_ms() > started {
                bytes as f64 * 1000.0 / (now_ms() - started) as f64
            } else {
                0.0
            };
            if phase == "done" {
                let frozen = self.final_speed.load(Ordering::SeqCst);
                if frozen > 0 {
                    frozen as f64
                } else {
                    self.final_speed.store(avg as u64, Ordering::SeqCst);
                    avg
                }
            } else {
                avg
            }
        } else {
            0.0
        };
        let book_brief = if book.version == 0 && book.files.is_empty() {
            None
        } else {
            let path = self
                .book_path
                .lock()
                .unwrap()
                .as_ref()
                .map(|p| p.to_string_lossy().to_string());
            Some(BookBrief {
                path,
                id: book.book_id.clone(),
                title: book.title.clone(),
                author: book.author.clone(),
                chapters: book.chapter_count,
                bytes: book.total_bytes,
                updated_at: book.updated_at,
                empty: book.files.is_empty(),
            })
        };
        TransferSnapshot {
            id: self.token.clone(),
            phase: phase.clone(),
            url: format!("http://{}:{}/t/{}", self.host, self.port, self.token),
            host: self.host.clone(),
            port: self.port,
            expires_at: self.expires_at,
            book: book_brief,
            device,
            direction,
            comparison,
            progress: TransferProgress {
                bytes_done: bytes,
                total_bytes: total,
                percent,
                speed,
                current_file: state.current_file.clone(),
                files_done: state.files_done,
                files_total: state.files_total,
                started_at: state.started_at,
            },
            can_confirm: phase == "ready" && self.phone.lock().unwrap().is_some(),
            error,
        }
    }

    fn emit(&self) {
        let _ = self.app.emit("transfer-update", self.snapshot());
    }

    fn set_phase(&self, phase: &str) {
        *self.phase.lock().unwrap() = phase.to_string();
        self.emit();
    }

    fn set_error(&self, message: impl Into<String>) {
        *self.error.lock().unwrap() = Some(message.into());
        self.set_phase("error");
    }
}

/* ───────────────────────── 指纹与比较 ───────────────────────── */

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn file_mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_book_bytes(book: &Path) -> Result<Vec<u8>, String> {
    let text = fs::read_to_string(book.join(BOOK_FILE)).map_err(|e| format!("读取书籍信息失败：{e}"))?;
    let mut value: Value = serde_json::from_str(&text).map_err(|e| format!("书籍信息不是合法 JSON：{e}"))?;
    if let Some(obj) = value.as_object_mut() {
        // 这些字段只服务于当前这台机器的界面：上次打开哪章、今天写了多少、缓存字数。
        obj.remove("lastChapterId");
        obj.remove("daily");
        obj.remove("wordCount");
    }
    serde_json::to_vec(&value).map_err(|e| format!("整理书籍信息失败：{e}"))
}

fn read_sync_bytes(book: &Path, path: &str) -> Result<Vec<u8>, String> {
    if path == BOOK_FILE {
        normalize_book_bytes(book)
    } else {
        fs::read(book.join(path)).map_err(|e| format!("读取 {path} 失败：{e}"))
    }
}

fn kind_of(path: &str) -> &'static str {
    if path == BOOK_FILE {
        "meta"
    } else if path == OUTLINE_FILE {
        "outline"
    } else if path == LORE_FILE {
        "lore"
    } else if path == PROOFREAD_FILE {
        "proofread"
    } else if path.starts_with("chapters/") {
        "chapter"
    } else if path.starts_with("notes/") {
        "note"
    } else if path.starts_with("assets/") {
        "asset"
    } else if path.starts_with("comic/") {
        "comic"
    } else {
        "file"
    }
}

fn collect_dir_files(
    base: &Path,
    current: &Path,
    prefix: &str,
    paths: &mut BTreeSet<String>,
) -> Result<(), String> {
    let entries = match fs::read_dir(current) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(name) => name,
            None => continue,
        };
        if name.starts_with('.') || name.ends_with(".tmp") || name.ends_with(".part") {
            continue;
        }
        if path.is_dir() {
            if matches!(name, "trash" | "tmp" | "cache") {
                continue;
            }
            collect_dir_files(base, &path, prefix, paths)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !matches!(ext.as_str(), "json" | "png" | "jpg" | "jpeg" | "webp") {
            continue;
        }
        let rel = path
            .strip_prefix(base)
            .map_err(|_| format!("无法计算同步路径：{}", path.display()))?
            .to_string_lossy()
            .replace('\\', "/");
        paths.insert(format!("{prefix}/{rel}"));
    }
    Ok(())
}

fn collect_sync_paths(book: &Path) -> Result<Vec<String>, String> {
    let mut paths = BTreeSet::new();
    if !book.is_dir() {
        return Ok(Vec::new());
    }
    for name in [BOOK_FILE, OUTLINE_FILE, LORE_FILE, PROOFREAD_FILE] {
        if book.join(name).is_file() {
            paths.insert(name.to_string());
        }
    }
    // 漫画工程：project.json + 每页 page.json、图层 PNG、素材与缩略图。
    // 只收已知类型，避免把系统垃圾或临时半成品带进同步包。
    let comic_root = book.join("comic");
    if comic_root.is_dir() {
        collect_dir_files(&comic_root, &comic_root, "comic", &mut paths)?;
    }
    for (dir, prefix, ext) in [
        (chapters_dir(book), "chapters", Some("md")),
        (book.join("notes"), "notes", Some("md")),
        (book.join("assets"), "assets", None),
    ] {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                let name = match p.file_name().and_then(|n| n.to_str()) {
                    Some(n) => n,
                    None => continue,
                };
                if name.starts_with('.') || name.ends_with(".tmp") || name.ends_with(".part") {
                    continue;
                }
                if let Some(ext) = ext {
                    if p.extension().and_then(|e| e.to_str()) != Some(ext) {
                        continue;
                    }
                }
                paths.insert(format!("{prefix}/{name}"));
            }
        }
    }
    Ok(paths.into_iter().collect())
}

fn count_chapters(book: &Path) -> usize {
    let text = match fs::read_to_string(book.join(OUTLINE_FILE)) {
        Ok(text) => text,
        Err(_) => return 0,
    };
    let value: Value = match serde_json::from_str(&text) {
        Ok(value) => value,
        Err(_) => return 0,
    };
    let mut total = 0usize;
    if let Some(volumes) = value.get("volumes").and_then(|v| v.as_array()) {
        for volume in volumes {
            total += volume
                .get("chapters")
                .and_then(|c| c.as_array())
                .map(|c| c.len())
                .unwrap_or(0);
        }
    }
    total
}

fn index_path(book: &Path) -> PathBuf {
    book.join("sync-index.json")
}

fn read_index(book: &Path) -> SyncIndex {
    let path = index_path(book);
    if let Ok(text) = fs::read_to_string(path) {
        if let Ok(mut index) = serde_json::from_str::<SyncIndex>(&text) {
            index.version = SYNC_VERSION;
            return index;
        }
    }
    SyncIndex {
        version: SYNC_VERSION,
        files: BTreeMap::new(),
    }
}

fn write_index(book: &Path, index: &SyncIndex) {
    if let Ok(text) = serde_json::to_string(index) {
        let _ = fs::write(index_path(book), text);
    }
}

fn build_manifest(book: Option<&Path>) -> Result<SyncManifest, String> {
    let Some(book) = book else {
        return Ok(SyncManifest {
            version: SYNC_VERSION,
            ..Default::default()
        });
    };
    if !book.is_dir() {
        return Ok(SyncManifest {
            version: SYNC_VERSION,
            ..Default::default()
        });
    }
    let mut index = read_index(book);
    let mut used = BTreeSet::new();
    let mut files = Vec::new();
    for path in collect_sync_paths(book)? {
        let meta = fs::metadata(book.join(&path)).map_err(|e| format!("读取 {path} 信息失败：{e}"))?;
        let size = meta.len();
        let mtime = file_mtime_ms(&meta);
        let bytes = read_sync_bytes(book, &path)?;
        let hash = match index.files.get(&path) {
            Some(entry) if entry.size == size && entry.mtime == mtime && !entry.hash.is_empty() => {
                entry.hash.clone()
            }
            _ => hash_bytes(&bytes),
        };
        let real_size = if path == BOOK_FILE { bytes.len() as u64 } else { size };
        used.insert(path.clone());
        let kind = kind_of(&path).to_string();
        files.push(SyncFile {
            path,
            kind,
            size: real_size,
            mtime,
            hash,
        });
    }
    let mut next_files = BTreeMap::new();
    for file in &files {
        next_files.insert(
            file.path.clone(),
            IndexEntry {
                size: fs::metadata(book.join(&file.path)).map(|m| m.len()).unwrap_or(file.size),
                mtime: file.mtime,
                hash: file.hash.clone(),
            },
        );
    }
    // 删掉已经不在书里的条目，索引永远只保留“当前最新”的一份。
    let stale: Vec<String> = index
        .files
        .keys()
        .filter(|key| !used.contains(*key))
        .cloned()
        .collect();
    for key in stale {
        index.files.remove(&key);
    }
    index.files = next_files;
    index.version = SYNC_VERSION;
    write_index(book, &index);

    let (book_id, title, author, updated_at) = fs::read_to_string(book.join(BOOK_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .map(|v| {
            (
                v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                v.get("title").and_then(|x| x.as_str()).unwrap_or("未命名").to_string(),
                v.get("author").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                v.get("updatedAt").and_then(|x| x.as_i64()).unwrap_or(0),
            )
        })
        .unwrap_or_default();
    let total_bytes = files.iter().map(|f| f.size).sum();
    Ok(SyncManifest {
        version: SYNC_VERSION,
        book_id,
        title,
        author,
        updated_at,
        chapter_count: count_chapters(book),
        total_bytes,
        files,
    })
}

fn empty_manifest() -> SyncManifest {
    SyncManifest {
        version: SYNC_VERSION,
        ..Default::default()
    }
}

fn compare_manifests(pc: &SyncManifest, phone: &SyncManifest) -> Comparison {
    let pc_map: BTreeMap<&str, &SyncFile> = pc.files.iter().map(|f| (f.path.as_str(), f)).collect();
    let phone_map: BTreeMap<&str, &SyncFile> =
        phone.files.iter().map(|f| (f.path.as_str(), f)).collect();
    let mut all = BTreeSet::new();
    all.extend(pc_map.keys().copied());
    all.extend(phone_map.keys().copied());

    let mut out = Comparison {
        pc_files: pc.files.len(),
        phone_files: phone.files.len(),
        pc_bytes: pc.total_bytes,
        phone_bytes: phone.total_bytes,
        ..Default::default()
    };
    for path in all {
        match (pc_map.get(path), phone_map.get(path)) {
            (Some(a), Some(b)) if a.hash == b.hash => {
                out.same += 1;
            }
            (Some(a), Some(b)) => {
                let state = if a.mtime > b.mtime {
                    out.pc_newer += 1;
                    "pcNewer"
                } else if b.mtime > a.mtime {
                    out.phone_newer += 1;
                    "phoneNewer"
                } else {
                    out.conflicts += 1;
                    "conflict"
                };
                out.items.push(CompareItem {
                    path: path.to_string(),
                    kind: a.kind.clone(),
                    state: state.to_string(),
                    pc_size: a.size,
                    phone_size: b.size,
                    pc_mtime: a.mtime,
                    phone_mtime: b.mtime,
                });
                out.changed_pc_to_phone += 1;
                out.changed_phone_to_pc += 1;
                out.changed_bytes_pc_to_phone += a.size;
                out.changed_bytes_phone_to_pc += b.size;
            }
            (Some(a), None) => {
                out.pc_only += 1;
                out.items.push(CompareItem {
                    path: path.to_string(),
                    kind: a.kind.clone(),
                    state: "pcOnly".into(),
                    pc_size: a.size,
                    phone_size: 0,
                    pc_mtime: a.mtime,
                    phone_mtime: 0,
                });
                out.changed_pc_to_phone += 1;
                out.changed_bytes_pc_to_phone += a.size;
            }
            (None, Some(b)) => {
                out.phone_only += 1;
                out.items.push(CompareItem {
                    path: path.to_string(),
                    kind: b.kind.clone(),
                    state: "phoneOnly".into(),
                    pc_size: 0,
                    phone_size: b.size,
                    pc_mtime: 0,
                    phone_mtime: b.mtime,
                });
                out.changed_phone_to_pc += 1;
                out.changed_bytes_phone_to_pc += b.size;
            }
            (None, None) => {}
        }
    }
    out.items.sort_by(|a, b| a.path.cmp(&b.path));
    if phone.files.is_empty() && !pc.files.is_empty() {
        out.suggested_direction = "pc_to_phone".into();
        out.confidence = "电脑有书，手机还没有这本书".into();
    } else if pc.files.is_empty() && !phone.files.is_empty() {
        out.suggested_direction = "phone_to_pc".into();
        out.confidence = "手机有书，电脑还没有这本书".into();
    } else {
        let pc_score = out.pc_newer + out.pc_only + out.conflicts;
        let phone_score = out.phone_newer + out.phone_only;
        out.suggested_direction = if pc_score >= phone_score {
            "pc_to_phone".into()
        } else {
            "phone_to_pc".into()
        };
        out.confidence = if out.conflicts > 0 {
            format!("双方有 {} 项时间相同但内容不同，默认按电脑", out.conflicts)
        } else if pc_score == phone_score {
            "两边改动差不多，默认按电脑".into()
        } else {
            "按最近修改时间判断".into()
        };
    }
    out
}

fn manifest_is_safe(manifest: &SyncManifest) -> Result<(), String> {
    if manifest.files.len() > MAX_MANIFEST_FILES {
        return Err("手机书目条目太多，已拒绝".into());
    }
    for file in &manifest.files {
        validate_rel_path(&file.path)?;
        if file.hash.len() > 128 {
            return Err("手机书目指纹格式不对".into());
        }
    }
    Ok(())
}

fn merge_book_values(old: Option<&Value>, new: &Value) -> Value {
    let mut merged = new.clone();
    if let (Some(obj), Some(old_obj)) = (merged.as_object_mut(), old.and_then(|v| v.as_object())) {
        // 手机/电脑各自的界面状态不和书稿一起覆盖。
        for key in ["lastChapterId", "daily", "wordCount"] {
            if let Some(value) = old_obj.get(key) {
                obj.insert(key.to_string(), value.clone());
            }
        }
        if !obj.contains_key("createdAt") {
            if let Some(value) = old_obj.get("createdAt") {
                obj.insert("createdAt".to_string(), value.clone());
            }
        }
    }
    merged
}

/* ───────────────────────── 打包与落盘 ───────────────────────── */

fn validate_rel_path(path: &str) -> Result<(), String> {
    if path.is_empty() || path.contains('\\') || path.starts_with('/') || path.starts_with("..") {
        return Err(format!("不安全的同步路径：{path}"));
    }
    let p = Path::new(path);
    for component in p.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err(format!("不安全的同步路径：{path}")),
        }
    }
    if path == "sync-manifest.json" || path == "sync-plan.json" || path == "sync-index.json" {
        return Err("同步包内出现了保留文件".into());
    }
    let allowed = path == BOOK_FILE
        || path == OUTLINE_FILE
        || path == LORE_FILE
        || path == PROOFREAD_FILE
        || path.starts_with("chapters/")
        || path.starts_with("notes/")
        || path.starts_with("assets/")
        || path.starts_with("comic/");
    if !allowed {
        return Err(format!("同步包里有不允许写入的文件：{path}"));
    }
    Ok(())
}

fn build_package(session: &TransferSession) -> Result<(PathBuf, u64, usize, usize), String> {
    let book = session.book_path.lock().unwrap().clone();
    let book = book.ok_or("电脑这边还没有选中一本书")?;
    let source = session.pc_manifest.lock().unwrap().clone();
    if source.files.is_empty() {
        return Err("电脑这本书还没有可传的内容".into());
    }
    let phone = session
        .phone
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|d| d.manifest.clone())
        .unwrap_or_else(empty_manifest);
    let target_map: BTreeMap<&str, &SyncFile> =
        phone.files.iter().map(|f| (f.path.as_str(), f)).collect();
    let changed: Vec<SyncFile> = source
        .files
        .iter()
        .filter(|f| match target_map.get(f.path.as_str()) {
            Some(target) => target.hash != f.hash,
            None => true,
        })
        .cloned()
        .collect();
    // 两边完全一致时不再直接结束：仍然按当前方向全量重传一遍。
    // 这样“没区别”只是比较结果，不是拒绝传输的理由。
    let changed = if changed.is_empty() {
        source.files.clone()
    } else {
        changed
    };
    let temp = std::env::temp_dir().join(format!("chapter-sync-{}.chapterpack", session.token));
    let file = File::create(&temp).map_err(|e| format!("创建同步包失败：{e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for f in &changed {
        let bytes = read_sync_bytes(&book, &f.path)?;
        zip.start_file(&f.path, options)
            .map_err(|e| format!("写入同步包失败：{e}"))?;
        zip.write_all(&bytes)
            .map_err(|e| format!("写入同步包失败：{e}"))?;
    }
    let manifest_bytes = serde_json::to_vec(&source).map_err(|e| format!("书目序列化失败：{e}"))?;
    zip.start_file("sync-manifest.json", options)
        .map_err(|e| format!("写入书目失败：{e}"))?;
    zip.write_all(&manifest_bytes)
        .map_err(|e| format!("写入书目失败：{e}"))?;
    let plan = json!({
        "version": SYNC_VERSION,
        "direction": "pc_to_phone",
        "generatedAt": now_ms(),
        "title": source.title,
        "files": changed.len(),
        "bytes": changed.iter().map(|f| f.size).sum::<u64>(),
    });
    zip.start_file("sync-plan.json", options)
        .map_err(|e| format!("写入同步计划失败：{e}"))?;
    zip.write_all(&serde_json::to_string(&plan).unwrap().as_bytes())
        .map_err(|e| format!("写入同步计划失败：{e}"))?;
    // 全站改动（打卡日历、主题、语言、编辑器偏好等）随书稿一起走，
    // 不再只同步正文。导入方会在写入后把这份数据交给界面层恢复。
    if let Some(app_data) = session.app_data.lock().unwrap().clone() {
        zip.start_file("sync-app.json", options)
            .map_err(|e| format!("写入全站数据失败：{e}"))?;
        zip.write_all(app_data.as_bytes())
            .map_err(|e| format!("写入全站数据失败：{e}"))?;
    }
    zip.finish().map_err(|e| format!("收尾同步包失败：{e}"))?;
    let size = fs::metadata(&temp).map(|m| m.len()).unwrap_or(0);
    Ok((temp, size, changed.len(), source.files.len()))
}

fn unique_book_dir(library: &Path, title: &str) -> PathBuf {
    let base = sanitize_name(if title.trim().is_empty() { "手机传回的书" } else { title });
    let mut name = format!("{base}.chapter");
    let mut n = 2;
    while library.join(&name).exists() {
        name = format!("{base} {n}.chapter");
        n += 1;
    }
    library.join(name)
}

/// 手机把当前书打成完整 `.chapterpack`，用于“手机 → 电脑”方向。
/// 返回 base64，前端直接 POST 给电脑的 /upload，不再需要先导出到文件管理器。
#[tauri::command]
pub fn export_chapterpack(path: String) -> Result<String, String> {
    let book = PathBuf::from(path);
    if !book.is_dir() {
        return Err("这本书的工程目录不存在".into());
    }
    let manifest = build_manifest(Some(&book))?;
    if manifest.files.is_empty() {
        return Err("这本书还没有可传的内容".into());
    }
    let temp = std::env::temp_dir().join(format!("chapter-phone-{}.chapterpack", now_ms()));
    let file = File::create(&temp).map_err(|e| format!("创建手机同步包失败：{e}"))?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for f in &manifest.files {
        let bytes = read_sync_bytes(&book, &f.path)?;
        zip.start_file(&f.path, options)
            .map_err(|e| format!("写入手机同步包失败：{e}"))?;
        zip.write_all(&bytes)
            .map_err(|e| format!("写入手机同步包失败：{e}"))?;
    }
    zip.start_file("sync-manifest.json", options)
        .map_err(|e| format!("写入手机书目失败：{e}"))?;
    zip.write_all(&serde_json::to_vec(&manifest).map_err(|e| format!("手机书目序列化失败：{e}"))?)
        .map_err(|e| format!("写入手机书目失败：{e}"))?;
    zip.finish().map_err(|e| format!("收尾手机同步包失败：{e}"))?;
    let bytes = fs::read(&temp).map_err(|e| format!("读取手机同步包失败：{e}"))?;
    let _ = fs::remove_file(&temp);
    if bytes.len() > 256 * 1024 * 1024 {
        return Err("手机书稿超过 256 MB，暂时不能走这一步".into());
    }
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        bytes,
    ))
}

/// 手机端从浏览器/文件管理器下载了 `.chapterpack`，用 WebView 的 file input
/// 把字节交给这里落成新书。绕开 Android SAF 的 `content://` 路径问题。
#[tauri::command]
pub fn import_chapterpack(data: String) -> Result<String, String> {
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        data.trim(),
    )
    .map_err(|e| format!("同步包数据损坏：{e}"))?;
    if bytes.is_empty() {
        return Err("同步包是空的".into());
    }
    if bytes.len() > 256 * 1024 * 1024 {
        return Err("同步包超过 256 MB，先确认是不是选错了文件".into());
    }
    let temp = std::env::temp_dir().join(format!("chapterpack-{}.zip", now_ms()));
    fs::write(&temp, &bytes).map_err(|e| format!("写入临时同步包失败：{e}"))?;
    let applied = apply_package(None, &temp);
    let app_data = read_app_data(&temp);
    let _ = fs::remove_file(&temp);
    let (dest, _) = applied?;
    Ok(serde_json::json!({
        "path": dest.to_string_lossy(),
        "appData": app_data,
    })
    .to_string())
}

fn apply_package(
    dest_book: Option<&Path>,
    package: &Path,
) -> Result<(PathBuf, SyncManifest), String> {
    let mut archive = ZipArchive::new(File::open(package).map_err(|e| format!("打开同步包失败：{e}"))?)
        .map_err(|e| format!("同步包损坏：{e}"))?;
    let mut new_book_value: Option<Value> = None;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取同步包条目失败：{e}"))?;
        let Some(name) = entry.enclosed_name() else {
            return Err("同步包里有不安全的路径".into());
        };
        let rel = name.to_string_lossy().replace('\\', "/");
        if rel == BOOK_FILE {
            let mut text = String::new();
            entry
                .read_to_string(&mut text)
                .map_err(|e| format!("读取书籍信息失败：{e}"))?;
            new_book_value = Some(
                serde_json::from_str(&text).map_err(|e| format!("同步包书籍信息不是合法 JSON：{e}"))?,
            );
        }
    }
    let new_book = new_book_value.ok_or("同步包里没有 book.json，无法确定是哪本书")?;

    let dest = match dest_book {
        Some(path) if path.exists() => path.to_path_buf(),
        Some(path) => path.to_path_buf(),
        None => {
            let library = load_library();
            ensure_dir(&library)?;
            let title = new_book.get("title").and_then(|v| v.as_str()).unwrap_or("手机传回的书");
            unique_book_dir(&library, title)
        }
    };
    ensure_dir(&dest)?;
    let old_book = fs::read_to_string(dest.join(BOOK_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let merged = merge_book_values(old_book.as_ref(), &new_book);

    // 先写书籍信息，再写其余内容；中途失败时至少不会把旧书信息弄丢。
    fs::write(
        dest.join(BOOK_FILE),
        serde_json::to_string_pretty(&merged).map_err(|e| format!("序列化书籍信息失败：{e}"))?,
    )
    .map_err(|e| format!("写入书籍信息失败：{e}"))?;

    let mut archive = ZipArchive::new(File::open(package).map_err(|e| format!("打开同步包失败：{e}"))?)
        .map_err(|e| format!("同步包损坏：{e}"))?;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取同步包条目失败：{e}"))?;
        let Some(name) = entry.enclosed_name() else {
            return Err("同步包里有不安全的路径".into());
        };
        let rel = name.to_string_lossy().replace('\\', "/");
        if rel == BOOK_FILE
            || rel == "sync-manifest.json"
            || rel == "sync-plan.json"
            || rel == "sync-app.json"
        {
            continue;
        }
        validate_rel_path(&rel)?;
        let out_path = dest.join(&rel);
        if let Some(parent) = out_path.parent() {
            ensure_dir(parent)?;
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取 {rel} 失败：{e}"))?;
        fs::write(&out_path, bytes).map_err(|e| format!("写入 {rel} 失败：{e}"))?;
    }
    // 旧索引里可能有对端没有的指纹，落盘后重新生成；不保留历史。
    let _ = fs::remove_file(index_path(&dest));
    ensure_project(&dest)?;
    let manifest = build_manifest(Some(&dest))?;
    Ok((dest, manifest))
}

fn read_app_data(package: &Path) -> Option<String> {
    let mut archive = ZipArchive::new(File::open(package).ok()?).ok()?;
    let mut entry = archive.by_name("sync-app.json").ok()?;
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    if value.get("entries").and_then(|v| v.as_object()).is_none() {
        return None;
    }
    Some(text)
}

/* ───────────────────────── HTTP 服务 ───────────────────────── */

fn local_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|socket| {
            socket.connect("8.8.8.8:80")?;
            socket.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".into())
}

fn token() -> String {
    let mut out = String::with_capacity(32);
    for _ in 0..32 {
        out.push(char::from_digit((fastrand::u32(0..16)) as u32, 16).unwrap());
    }
    out
}

fn json_header() -> Header {
    Header::from_bytes("Content-Type", "application/json; charset=utf-8").unwrap()
}

fn cors_header() -> Header {
    Header::from_bytes("Access-Control-Allow-Origin", "*").unwrap()
}

fn respond_json(req: Request, status: u16, value: Value) {
    let body = serde_json::to_string(&value).unwrap_or_else(|_| "{\"error\":\"序列化失败\"}".into());
    let response = Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(json_header())
        .with_header(cors_header());
    let _ = req.respond(response);
}

fn read_json_body(req: &mut Request) -> Result<Value, String> {
    let len = content_length(req).unwrap_or(0);
    if len > 2 * 1024 * 1024 {
        return Err("请求体太大".into());
    }
    let mut text = String::new();
    req.as_reader()
        .take(2 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .map_err(|e| format!("读取请求失败：{e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("请求不是合法 JSON：{e}"))
}

fn content_length(req: &Request) -> Option<u64> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv("Content-Length"))
        .and_then(|h| h.value.as_str().parse::<u64>().ok())
}

fn device_from_body(body: &Value) -> Result<DeviceInfo, String> {
    let name = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("手机")
        .trim()
        .chars()
        .take(80)
        .collect::<String>();
    let platform = body
        .get("platform")
        .and_then(|v| v.as_str())
        .unwrap_or("android")
        .to_string();
    let model = body
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let app_version = body
        .get("appVersion")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let manifest = match body.get("manifest") {
        Some(value) if !value.is_null() => {
            let manifest: SyncManifest = serde_json::from_value(value.clone())
                .map_err(|e| format!("手机书目格式不对：{e}"))?;
            manifest_is_safe(&manifest)?;
            Some(manifest)
        }
        _ => None,
    };
    Ok(DeviceInfo {
        name: if name.is_empty() { "手机".into() } else { name },
        platform,
        model,
        app_version,
        last_seen_at: now_ms(),
        manifest,
    })
}

fn handle_pair(session: &Arc<TransferSession>, mut req: Request) {
    let body = match read_json_body(&mut req) {
        Ok(body) => body,
        Err(error) => {
            respond_json(req, 400, json!({ "error": error }));
            return;
        }
    };
    let device = match device_from_body(&body) {
        Ok(device) => device,
        Err(error) => {
            respond_json(req, 400, json!({ "error": error }));
            return;
        }
    };
    let phone_manifest = device.manifest.clone().unwrap_or_else(empty_manifest);
    let pc_manifest = session.pc_manifest.lock().unwrap().clone();
    let comparison = compare_manifests(&pc_manifest, &phone_manifest);
    *session.direction.lock().unwrap() = comparison.suggested_direction.clone();
    *session.comparison.lock().unwrap() = Some(comparison);
    *session.phone.lock().unwrap() = Some(device);
    *session.phase.lock().unwrap() = "ready".into();
    let snapshot = session.snapshot();
    session.emit();
    respond_json(req, 200, serde_json::to_value(snapshot).unwrap_or(Value::Null));
}

fn handle_manifest(session: &Arc<TransferSession>, mut req: Request) {
    let body = match read_json_body(&mut req) {
        Ok(body) => body,
        Err(error) => {
            respond_json(req, 400, json!({ "error": error }));
            return;
        }
    };
    let manifest: SyncManifest = match body.get("manifest") {
        Some(value) => match serde_json::from_value(value.clone()) {
            Ok(manifest) => manifest,
            Err(error) => {
                respond_json(req, 400, json!({ "error": format!("手机书目格式不对：{error}") }));
                return;
            }
        },
        None => match serde_json::from_value(body.clone()) {
            Ok(manifest) => manifest,
            Err(error) => {
                respond_json(req, 400, json!({ "error": format!("手机书目格式不对：{error}") }));
                return;
            }
        },
    };
    if let Err(error) = manifest_is_safe(&manifest) {
        respond_json(req, 400, json!({ "error": error }));
        return;
    }
    if let Some(device) = session.phone.lock().unwrap().as_mut() {
        device.manifest = Some(manifest.clone());
        device.last_seen_at = now_ms();
    } else {
        respond_json(req, 409, json!({ "error": "手机还没有绑定" }));
        return;
    }
    let pc_manifest = session.pc_manifest.lock().unwrap().clone();
    let comparison = compare_manifests(&pc_manifest, &manifest);
    *session.direction.lock().unwrap() = comparison.suggested_direction.clone();
    *session.comparison.lock().unwrap() = Some(comparison);
    *session.phase.lock().unwrap() = "ready".into();
    let snapshot = session.snapshot();
    session.emit();
    respond_json(req, 200, serde_json::to_value(snapshot).unwrap_or(Value::Null));
}

struct ProgressReader {
    file: File,
    bytes: Arc<AtomicU64>,
}

impl Read for ProgressReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.file.read(buf)?;
        if n > 0 {
            self.bytes.fetch_add(n as u64, Ordering::SeqCst);
        }
        Ok(n)
    }
}

fn content_disposition(filename: &str) -> String {
    let mut fallback = String::new();
    for ch in filename.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | ' ') {
            fallback.push(ch);
        } else {
            fallback.push('_');
        }
    }
    if fallback.trim().is_empty() {
        fallback.push_str("Chapter.chapterpack");
    }
    let mut encoded = String::new();
    for byte in filename.as_bytes() {
        let b = *byte;
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            encoded.push(b as char);
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

fn handle_download(session: &Arc<TransferSession>, req: Request) {
    let direction = session.direction.lock().unwrap().clone();
    if direction != "pc_to_phone" {
        respond_json(req, 409, json!({ "error": "当前方向是手机 → 电脑，电脑没有可下载的包" }));
        return;
    }
    let phase = session.phase.lock().unwrap().clone();
    if phase != "transferring" {
        respond_json(req, 409, json!({ "error": "电脑还没有确认开始传输" }));
        return;
    }
    let zip = session.zip_path.lock().unwrap().clone();
    let Some(zip) = zip else {
        respond_json(req, 409, json!({ "error": "同步包还没有准备好" }));
        return;
    };
    let file = match File::open(&zip) {
        Ok(file) => file,
        Err(error) => {
            respond_json(req, 500, json!({ "error": format!("打开同步包失败：{error}") }));
            return;
        }
    };
    let total = fs::metadata(&zip).map(|m| m.len()).unwrap_or(0);
    eprintln!("[transfer] download open {} bytes={}", zip.display(), total);
    let files_total = session
        .comparison
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.changed_pc_to_phone)
        .unwrap_or(0);
    *session.progress_state.lock().unwrap() = ProgressState {
        current_file: "整本书稿".into(),
        files_done: 0,
        files_total,
        started_at: now_ms(),
    };
    session.total_bytes.store(total, Ordering::SeqCst);
    session.bytes_done.store(0, Ordering::SeqCst);
    session.sample_at.store(now_ms(), Ordering::SeqCst);
    session.final_speed.store(0, Ordering::SeqCst);
    eprintln!("[transfer] download state ready files={files_total}");
    let title = session.pc_manifest.lock().unwrap().title.clone();
    eprintln!("[transfer] download title={title}");
    let filename = format!("{}.chapterpack", sanitize_name(if title.is_empty() { "Chapter" } else { &title }));
    let disposition = content_disposition(&filename);
    let response = Response::new(
        StatusCode(200),
        vec![
            Header::from_bytes("Content-Type", "application/zip").unwrap(),
            Header::from_bytes("Content-Disposition", disposition.as_bytes()).unwrap(),
            cors_header(),
        ],
        ProgressReader {
            file,
            bytes: session.bytes_done.clone(),
        },
        Some(total as usize),
        None,
    );
    eprintln!("[transfer] download responding");
    let result = req.respond(response);
    eprintln!("[transfer] download respond done ok={}", result.is_ok());
    let done = session.bytes_done.load(Ordering::SeqCst);
    {
        let mut state = session.progress_state.lock().unwrap();
        state.files_done = state.files_total;
        state.current_file.clear();
    }
    if result.is_ok() && done >= total {
        session.set_phase("done");
    } else {
        session.set_error(format!("下载中断：已发送 {} / {} 字节", done, total));
    }
}

fn handle_upload(session: &Arc<TransferSession>, mut req: Request) {
    let direction = session.direction.lock().unwrap().clone();
    if direction != "phone_to_pc" {
        respond_json(req, 409, json!({ "error": "当前方向是电脑 → 手机，电脑不接收上传" }));
        return;
    }
    let phase = session.phase.lock().unwrap().clone();
    if phase != "transferring" {
        respond_json(req, 409, json!({ "error": "电脑还没有确认开始传输" }));
        return;
    }
    let total = content_length(&req).unwrap_or(0);
    if total == 0 {
        respond_json(req, 411, json!({ "error": "缺少 Content-Length" }));
        return;
    }
    if total > 4 * 1024 * 1024 * 1024 {
        respond_json(req, 413, json!({ "error": "同步包超过 4GB，已拒绝" }));
        return;
    }
    let temp = std::env::temp_dir().join(format!("chapter-upload-{}.chapterpack", session.token));
    let mut file = match File::create(&temp) {
        Ok(file) => file,
        Err(error) => {
            respond_json(req, 500, json!({ "error": format!("创建临时文件失败：{error}") }));
            return;
        }
    };
    let files_total = session
        .comparison
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| c.changed_phone_to_pc)
        .unwrap_or(0);
    *session.progress_state.lock().unwrap() = ProgressState {
        current_file: "接收手机书稿".into(),
        files_done: 0,
        files_total,
        started_at: now_ms(),
    };
    session.total_bytes.store(total, Ordering::SeqCst);
    session.bytes_done.store(0, Ordering::SeqCst);
    session.sample_at.store(now_ms(), Ordering::SeqCst);
    session.final_speed.store(0, Ordering::SeqCst);
    session.emit();
    let mut buf = vec![0u8; 64 * 1024];
    let mut written = 0u64;
    let reader = req.as_reader();
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if let Err(error) = file.write_all(&buf[..n]) {
                    let _ = fs::remove_file(&temp);
                    session.set_error(format!("写临时文件失败：{error}"));
                    return;
                }
                written += n as u64;
                session.bytes_done.store(written, Ordering::SeqCst);
            }
            Err(error) => {
                let _ = fs::remove_file(&temp);
                session.set_error(format!("接收中断：{error}"));
                return;
            }
        }
    }
    drop(file);
    if written < total {
        let _ = fs::remove_file(&temp);
        session.set_error(format!("接收不完整：{written} / {total} 字节"));
        return;
    }
    session.set_phase("applying");
    let book = session.book_path.lock().unwrap().clone();
    let applied = apply_package(book.as_deref(), &temp);
    let app_data = read_app_data(&temp);
    let _ = fs::remove_file(&temp);
    match applied {
        Ok((dest, manifest)) => {
            *session.book_path.lock().unwrap() = Some(dest.clone());
            *session.pc_manifest.lock().unwrap() = manifest;
            *session.comparison.lock().unwrap() = None;
            {
                let mut state = session.progress_state.lock().unwrap();
                state.files_done = state.files_total;
                state.current_file.clear();
            }
            session.set_phase("done");
            let path = dest.to_string_lossy().to_string();
            let _ = session.app.emit(
                "transfer-applied",
                json!({ "path": path, "appData": app_data }),
            );
            respond_json(
                req,
                200,
                json!({
                    "ok": true,
                    "path": path,
                    "title": session.pc_manifest.lock().unwrap().title,
                    "appData": app_data
                }),
            );
        }
        Err(error) => {
            session.set_error(error.clone());
            respond_json(req, 500, json!({ "error": error }));
        }
    }
}

fn handle_request(session: &Arc<TransferSession>, req: Request) {
    let method = req.method().as_str().to_uppercase();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or("").to_string();
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();

    if method == "OPTIONS" {
        let response = Response::empty(StatusCode(204))
            .with_header(cors_header())
            .with_header(Header::from_bytes("Access-Control-Allow-Methods", "GET, POST, OPTIONS").unwrap())
            .with_header(Header::from_bytes("Access-Control-Allow-Headers", "Content-Type").unwrap());
        let _ = req.respond(response);
        return;
    }

    if parts.len() == 2 && parts[0] == "t" {
        if parts[1] != session.token {
            respond_json(req, 404, json!({ "error": "二维码已失效" }));
            return;
        }
        if method != "GET" {
            respond_json(req, 405, json!({ "error": "只支持 GET" }));
            return;
        }
        let url = format!("http://{}:{}/t/{}", session.host, session.port, session.token);
        let html = phone_page(&session.token, &session.pc_manifest.lock().unwrap().title, &url);
        let response = Response::from_string(html)
            .with_header(Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap())
            .with_header(cors_header());
        let _ = req.respond(response);
        return;
    }

    if parts.len() == 3 && parts[0] == "api" && parts[1] == session.token {
        match (method.as_str(), parts[2]) {
            ("GET", "state") => {
                let snapshot = session.snapshot();
                respond_json(req, 200, serde_json::to_value(snapshot).unwrap_or(Value::Null));
            }
            ("POST", "pair") => handle_pair(session, req),
            ("POST", "manifest") => handle_manifest(session, req),
            ("GET", "download") => handle_download(session, req),
            ("POST", "upload") => handle_upload(session, req),
            _ => respond_json(req, 404, json!({ "error": "没有这个接口" })),
        }
        return;
    }
    respond_json(req, 404, json!({ "error": "地址不对，请重新扫码" }));
}

/* ───────────────────────── 手机页面 ───────────────────────── */

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn phone_page(token: &str, title: &str, url: &str) -> String {
    let page = r#"<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Chapter 手机互传</title>
<style>
:root{color-scheme:light dark;--bg:#f7f1e7;--card:#fffaf3;--ink:#2b2117;--muted:#7a6c5d;--line:#e6d8c6;--accent:#b65c28;--ok:#2e7d52;--bad:#b23b32}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(160deg,#f7f1e7,#efe3d4 60%,#e9dbcb);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:28px 18px 42px}
.eyebrow{font-size:11px;letter-spacing:.16em;color:var(--muted)}h1{font-family:Georgia,"Songti SC",serif;font-size:26px;margin:7px 0 8px;font-weight:600}
.sub{font-size:13px;line-height:1.7;color:var(--muted);margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:18px;margin:14px 0;box-shadow:0 14px 40px rgba(80,52,25,.08)}
.row{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px}.row:last-child{border-bottom:0}.row b{font-weight:600}
.pill{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border-radius:999px;font-size:11px;background:#efe3d4;color:var(--muted)}
.pill.ok{background:#e4f2e9;color:var(--ok)}.pill.bad{background:#f7e2df;color:var(--bad)}
.btn{width:100%;height:48px;border:0;border-radius:14px;background:var(--accent);color:#fff;font-size:15px;font-weight:600;margin-top:10px;cursor:pointer}
.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
.btn:disabled{opacity:.45;cursor:default}
.bar{height:10px;border-radius:999px;background:#e9dccb;overflow:hidden;margin:12px 0 8px}.bar i{display:block;height:100%;width:0%;background:var(--accent);transition:width .3s}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--muted);word-break:break-all}
.note{font-size:12px;line-height:1.7;color:var(--muted)}.warn{background:#fff3df;border-color:#efd4b0;color:#8a4c14}
.hide{display:none}.big{font-size:32px;font-weight:700;letter-spacing:-.02em}
select,input[type=file]{width:100%;margin-top:10px;font-size:13px}
select{height:40px;border-radius:12px;border:1px solid var(--line);background:#fff;color:var(--ink);padding:0 10px}
</style></head><body><div class="wrap">
<div class="eyebrow">CHAPTER / LOCAL TRANSFER</div>
<h1>手机与电脑互传</h1>
<p class="sub">只走同一个 Wi-Fi，不上云。先绑定，再由电脑确认方向；传输中请不要退出。</p>
<div class="card" id="statusCard"><div class="row"><span>连接状态</span><b id="phase">正在连接…</b></div><div class="row"><span>电脑上的书</span><b id="bookTitle">__TITLE__</b></div><div class="row"><span>本机</span><b id="device">未绑定</b></div></div>
<div class="card" id="pairCard"><p class="note">扫码后先点下面的按钮。电脑端会弹出确认；确认之后才会比较书稿。</p><button class="btn" id="pairBtn">绑定这台手机</button></div>
<div class="card hide" id="readyCard"><div class="row"><span>电脑判断</span><b id="suggest">—</b></div><div class="row"><span>方向</span><b id="direction">—</b></div><div class="row"><span>需要传</span><b id="changed">—</b></div><p class="note" id="compareNote"></p><p class="note warn" id="confirmNote">请在电脑上确认方向并点击“确认传输”。</p></div>
<div class="card hide" id="progressCard"><div class="pill" id="progPill">传输中</div><div class="bar"><i id="bar"></i></div><div class="row"><span id="progText">0%</span><span id="speed">0 B/s</span></div><p class="note warn">传输中请不要退出 Chapter，也不要锁屏或切走 Wi-Fi。</p><div id="downloadArea" class="hide"><button class="btn" id="downloadBtn">接收电脑书稿</button></div><div id="uploadArea" class="hide"><input type="file" id="fileInput" accept=".chapterpack,.zip"><button class="btn" id="uploadBtn">把手机书稿传给电脑</button></div></div>
<div class="card hide" id="doneCard"><div class="pill ok">已完成</div><p class="note" id="doneText">传输完成，可以回到 Chapter。</p><button class="btn ghost" id="refreshBtn">刷新状态</button></div>
<div class="card hide" id="errorCard"><div class="pill bad">出错了</div><p class="note" id="errorText"></p><button class="btn ghost" id="retryBtn">重新查询</button></div>
<p class="mono">__URL__</p>
</div>
<script>
const TOKEN="__TOKEN__";const base="/api/"+TOKEN;
let snapshot=null,paired=false,busy=false;
const $=id=>document.getElementById(id);
function fmtBytes(n){if(!n)return"0 B";const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return (n<10?n.toFixed(1):Math.round(n))+" "+u[i]}
function deviceName(){const ua=navigator.userAgent||"";if(/iPhone|iPad/i.test(ua))return"iPhone / Safari";if(/Android/i.test(ua))return"Android 手机";return"电脑浏览器（模拟手机）"}
async function getState(){try{const r=await fetch(base+"/state",{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);snapshot=await r.json();render()}catch(e){showError("连不上电脑："+e.message)}}
async function pair(){if(busy)return;busy=true;$("pairBtn").disabled=true;try{const r=await fetch(base+"/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:deviceName(),platform:"web",model:navigator.userAgent.slice(0,120),appVersion:"chapter-web/1"})});if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||"绑定失败")}paired=true;snapshot=await r.json();render()}catch(e){showError(e.message)}finally{busy=false;$("pairBtn").disabled=false}}
function render(){if(!snapshot)return;const p=snapshot.phase;const phaseText={waiting:"等待绑定",ready:"已绑定 · 等待电脑确认",preparing:"电脑正在准备书稿",transferring:"正在传输",applying:"电脑正在整理书稿",done:"已完成",error:"出错"}[p]||p;$("phase").textContent=phaseText;$("phase").className=p==="done"?"ok":p==="error"?"bad":"";
$("bookTitle").textContent=snapshot.book?snapshot.book.title:"电脑还没选书";$("device").textContent=snapshot.device?snapshot.device.name:"未绑定";
$("pairCard").classList.toggle("hide",!!snapshot.device);
const ready=p==="ready"||p==="preparing"||p==="transferring"||p==="applying"||p==="done";$("readyCard").classList.toggle("hide",!ready);
if(snapshot.comparison){const c=snapshot.comparison;const dir=snapshot.direction==="pc_to_phone"?"电脑 → 手机":"手机 → 电脑";$("suggest").textContent=c.suggestedDirection==="pc_to_phone"?"电脑 → 手机":"手机 → 电脑";$("direction").textContent=dir;const n=snapshot.direction==="pc_to_phone"?c.changedPcToPhone:c.changedPhoneToPc;const b=snapshot.direction==="pc_to_phone"?c.changedBytesPcToPhone:c.changedBytesPhoneToPc;$("changed").textContent=n+" 项 · "+fmtBytes(b);$("compareNote").textContent="电脑 "+c.pcFiles+" 项 / "+fmtBytes(c.pcBytes)+"；手机 "+c.phoneFiles+" 项 / "+fmtBytes(c.phoneBytes)+"。只传有变化的文件。";$("confirmNote").classList.toggle("hide",p!=="ready")}
$("progressCard").classList.toggle("hide",p!=="preparing"&&p!=="transferring"&&p!=="applying");
if(p==="preparing"||p==="transferring"||p==="applying"){const pr=snapshot.progress;$("bar").style.width=(pr.percent||0).toFixed(1)+"%";$("progText").textContent=(pr.percent||0).toFixed(1)+"% · "+fmtBytes(pr.bytesDone)+" / "+fmtBytes(pr.totalBytes);$("speed").textContent=fmtBytes(pr.speed||0)+"/s";$("progPill").textContent=p==="applying"?"正在落盘":"传输中";const isDownload=snapshot.direction==="pc_to_phone";$("downloadArea").classList.toggle("hide",!isDownload||p!=="transferring");$("uploadArea").classList.toggle("hide",isDownload||p!=="transferring")}
$("doneCard").classList.toggle("hide",p!=="done");$("errorCard").classList.toggle("hide",p!=="error");if(p==="error")$("errorText").textContent=snapshot.error||"未知错误"
}
async function download(){const btn=$("downloadBtn");btn.disabled=true;try{const r=await fetch(base+"/download");if(!r.ok){const j=await r.json().catch(()=>({}));throw new Error(j.error||"下载失败")}const total=Number(r.headers.get("Content-Length")||0);const reader=r.body.getReader();const chunks=[];let got=0;while(true){const {done,value}=await reader.read();if(done)break;chunks.push(value);got+=value.length;const pct=total?(got/total*100):0;$("bar").style.width=pct.toFixed(1)+"%";$("progText").textContent=pct.toFixed(1)+"% · "+fmtBytes(got)+" / "+fmtBytes(total)}const blob=new Blob(chunks,{type:"application/zip"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="Chapter.chapterpack";a.click();setTimeout(()=>URL.revokeObjectURL(a.href),4000);$("doneText").textContent="已接收电脑书稿。之后在 Chapter 里导入这个 .chapterpack，会只合并变化的内容。";getState()}catch(e){showError(e.message)}finally{btn.disabled=false}}
async function upload(){const file=$("fileInput").files[0];if(!file)return showError("先选择一个 .chapterpack 文件");const btn=$("uploadBtn");btn.disabled=true;try{await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open("POST",base+"/upload");xhr.setRequestHeader("Content-Type","application/zip");xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=e.loaded/e.total*100;$("bar").style.width=p.toFixed(1)+"%";$("progText").textContent=p.toFixed(1)+"% · "+fmtBytes(e.loaded)+" / "+fmtBytes(e.total)}};xhr.onload=()=>{if(xhr.status>=200&&xhr.status<300)resolve();else{let msg="上传失败";try{msg=JSON.parse(xhr.responseText).error||msg}catch(_){}reject(new Error(msg))}};xhr.onerror=()=>reject(new Error("网络中断"));xhr.send(file)});$("doneText").textContent="手机书稿已经写到电脑。可以回到电脑上的 Chapter 打开这本书。";getState()}catch(e){showError(e.message)}finally{btn.disabled=false}}
function showError(text){$("errorCard").classList.remove("hide");$("errorText").textContent=text}
$("pairBtn").onclick=pair;$("downloadBtn").onclick=download;$("uploadBtn").onclick=upload;$("refreshBtn").onclick=getState;$("retryBtn").onclick=getState;
getState();let autoPairTried=false;setInterval(()=>{getState();if(!autoPairTried&&!busy&&snapshot&&!snapshot.device){autoPairTried=true;pair()}},500);
</script></body></html>"#;
    page.replace("__TOKEN__", token)
        .replace("__TITLE__", &html_escape(title))
        .replace("__URL__", &html_escape(url))
}

/* ───────────────────────── Tauri 命令 ───────────────────────── */

#[tauri::command]
pub fn sync_manifest(path: String) -> Result<SyncManifest, String> {
    let dir = PathBuf::from(path);
    if !dir.is_dir() {
        return Err("这本书的工程目录不存在".into());
    }
    build_manifest(Some(&dir))
}

#[tauri::command]
pub fn transfer_start(
    app: AppHandle,
    book_path: Option<String>,
    app_data: Option<String>,
) -> Result<TransferSnapshot, String> {
    stop_session();
    let book = book_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir());
    let manifest = build_manifest(book.as_deref())?;
    let app_data = match app_data {
        Some(text) if !text.trim().is_empty() => {
            if text.len() > 2 * 1024 * 1024 {
                return Err("全站数据超过 2 MB，已拒绝".into());
            }
            let value: Value =
                serde_json::from_str(&text).map_err(|e| format!("全站数据不是合法 JSON：{e}"))?;
            if value.get("entries").and_then(|v| v.as_object()).is_none() {
                return Err("全站数据缺少 entries".into());
            }
            Some(text)
        }
        _ => None,
    };
    let token = token();
    let server = Arc::new(
        Server::http("0.0.0.0:0").map_err(|e| format!("开启互传服务失败：{e}"))?,
    );
    let addr = server
        .server_addr()
        .to_ip()
        .ok_or("没有拿到互传端口")?;
    let port = addr.port();
    let host = local_ip();
    let session = Arc::new(TransferSession {
        token: token.clone(),
        host: host.clone(),
        port,
        expires_at: now_ms() + TOKEN_TTL_MS,
        book_path: Mutex::new(book),
        pc_manifest: Mutex::new(manifest),
        phone: Mutex::new(None),
        comparison: Mutex::new(None),
        direction: Mutex::new("pc_to_phone".into()),
        phase: Mutex::new("waiting".into()),
        progress_state: Mutex::new(ProgressState::default()),
        bytes_done: Arc::new(AtomicU64::new(0)),
        total_bytes: Arc::new(AtomicU64::new(0)),
        sample_at: Arc::new(AtomicI64::new(0)),
        final_speed: Arc::new(AtomicU64::new(0)),
        zip_path: Mutex::new(None),
        app_data: Mutex::new(app_data),
        error: Mutex::new(None),
        app: app.clone(),
        server: server.clone(),
        stop: AtomicBool::new(false),
    });
    let runner = session.clone();
    thread::spawn(move || {
        while !runner.stop.load(Ordering::SeqCst) {
            if runner.phase.lock().unwrap().as_str() == "waiting"
                && now_ms() > runner.expires_at
            {
                runner.set_error("二维码已过期，请重新生成");
                break;
            }
            match runner.server.recv_timeout(Duration::from_millis(180)) {
                Ok(Some(req)) => {
                    let worker = runner.clone();
                    thread::spawn(move || handle_request(&worker, req));
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });
    let snapshot = session.snapshot();
    eprintln!("[transfer] {}", snapshot.url);
    *SESSION.lock().unwrap() = Some(session);
    Ok(snapshot)
}

#[tauri::command]
pub fn transfer_status() -> Result<TransferSnapshot, String> {
    SESSION
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.snapshot())
        .ok_or_else(|| "没有正在进行中的互传".into())
}

#[tauri::command]
pub fn transfer_direction(direction: String) -> Result<TransferSnapshot, String> {
    if direction != "pc_to_phone" && direction != "phone_to_pc" {
        return Err("方向只能是 pc_to_phone 或 phone_to_pc".into());
    }
    let session = SESSION
        .lock()
        .unwrap()
        .clone()
        .ok_or("没有正在进行中的互传")?;
    let phase = session.phase.lock().unwrap().clone();
    if phase == "preparing" || phase == "transferring" || phase == "applying" {
        return Err("已经开始传输，不能再改方向".into());
    }
    if session.comparison.lock().unwrap().is_none() {
        return Err("手机还没有提供书目，先等绑定完成".into());
    }
    *session.direction.lock().unwrap() = direction;
    session.emit();
    Ok(session.snapshot())
}

#[tauri::command]
pub fn transfer_confirm() -> Result<TransferSnapshot, String> {
    let session = SESSION
        .lock()
        .unwrap()
        .clone()
        .ok_or("没有正在进行中的互传")?;
    let phase = session.phase.lock().unwrap().clone();
    if phase != "ready" {
        return Err("现在还不能确认传输".into());
    }
    if session.phone.lock().unwrap().is_none() {
        return Err("手机还没有绑定".into());
    }
    let comparison = session
        .comparison
        .lock()
        .unwrap()
        .clone()
        .ok_or("还没有比较结果")?;
    let direction = session.direction.lock().unwrap().clone();
    // 0 项差异也允许继续：电脑 → 手机会打全量包，手机 → 电脑会等待手机上传全量包。
    *session.progress_state.lock().unwrap() = ProgressState {
        current_file: "正在准备同步包".into(),
        files_done: 0,
        files_total: if direction == "pc_to_phone" {
            comparison.changed_pc_to_phone
        } else {
            comparison.changed_phone_to_pc
        },
        started_at: 0,
    };
    *session.phase.lock().unwrap() = "preparing".into();
    session.emit();
    if direction == "pc_to_phone" {
        let worker = session.clone();
        thread::spawn(move || match build_package(&worker) {
            Ok((path, size, changed, _total)) => {
                *worker.zip_path.lock().unwrap() = Some(path);
                worker.total_bytes.store(size, Ordering::SeqCst);
                worker.bytes_done.store(0, Ordering::SeqCst);
                {
                    let mut state = worker.progress_state.lock().unwrap();
                    state.files_total = changed;
                    state.current_file = "等待手机接收".into();
                }
                worker.set_phase("transferring");
            }
            Err(error) => worker.set_error(error),
        });
    } else {
        *session.phase.lock().unwrap() = "transferring".into();
        let phone_bytes = comparison.changed_bytes_phone_to_pc;
        session.total_bytes.store(phone_bytes, Ordering::SeqCst);
        session.bytes_done.store(0, Ordering::SeqCst);
        {
            let mut state = session.progress_state.lock().unwrap();
            state.current_file = "等待手机上传".into();
            state.started_at = now_ms();
        }
        session.emit();
    }
    Ok(session.snapshot())
}

#[tauri::command]
pub fn transfer_cancel() -> Result<TransferSnapshot, String> {
    let session = SESSION
        .lock()
        .unwrap()
        .clone()
        .ok_or("没有正在进行中的互传")?;
    session.stop.store(true, Ordering::SeqCst);
    session.server.unblock();
    *session.error.lock().unwrap() = Some("已取消这次互传".into());
    *session.phase.lock().unwrap() = "cancelled".into();
    session.emit();
    Ok(session.snapshot())
}

#[tauri::command]
pub fn transfer_close() -> Result<(), String> {
    stop_session();
    Ok(())
}

fn stop_session() {
    let old = SESSION.lock().unwrap().take();
    if let Some(session) = old {
        session.stop.store(true, Ordering::SeqCst);
        session.server.unblock();
        if let Some(path) = session.zip_path.lock().unwrap().take() {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "chapter-sync-test-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = fs::remove_dir_all(&root);
        ensure_dir(&root).unwrap();
        root
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            ensure_dir(parent).unwrap();
        }
        fs::write(path, text).unwrap();
    }

    #[test]
    fn comic_paths_are_collected_and_allowed() {
        let root = temp_root("collect");
        let book = root.join("comic-book");
        write(&book.join(BOOK_FILE), r#"{"title":"测试漫画","kind":"comic"}"#);
        write(&book.join("comic/project.json"), r#"{"kind":"comic","pages":[]}"#);
        write(
            &book.join("comic/pages/p_1/page.json"),
            r#"{"id":"p_1","frames":[]}"#,
        );
        write(&book.join("comic/pages/p_1/layers/l_1.png"), "png");
        write(&book.join("comic/pages/p_1/assets/a_1.png"), "png");
        write(&book.join("comic/pages/p_1/thumbs/t.png"), "png");
        write(&book.join("comic/pages/p_1/layers/_.tmp"), "tmp");
        write(
            &book.join("comic/trash/p_old/page.json"),
            r#"{"id":"p_old","frames":[]}"#,
        );

        let paths = collect_sync_paths(&book).unwrap();
        assert!(paths.contains(&"comic/project.json".to_string()));
        assert!(paths.contains(&"comic/pages/p_1/page.json".to_string()));
        assert!(paths.contains(&"comic/pages/p_1/layers/l_1.png".to_string()));
        assert!(paths.contains(&"comic/pages/p_1/assets/a_1.png".to_string()));
        assert!(paths.contains(&"comic/pages/p_1/thumbs/t.png".to_string()));
        assert!(!paths.iter().any(|p| p.ends_with("_.tmp")));
        assert!(!paths.iter().any(|p| p.contains("/trash/")));
        for path in paths {
            validate_rel_path(&path).unwrap();
        }
        assert!(validate_rel_path("comic/pages/p_1/../../../etc/passwd").is_err());
        assert!(validate_rel_path("comic/../book.json").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn comic_package_applies_to_book() {
        let root = temp_root("apply");
        let source = root.join("source");
        write(&source.join(BOOK_FILE), r#"{"title":"漫画互传","kind":"comic"}"#);
        write(&source.join("comic/project.json"), r#"{"kind":"comic","pages":[]}"#);
        write(
            &source.join("comic/pages/p_1/page.json"),
            r#"{"id":"p_1","frames":[]}"#,
        );
        write(&source.join("comic/pages/p_1/layers/l_1.png"), "png");

        let pack = root.join("comic.chapterpack");
        let file = File::create(&pack).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for path in collect_sync_paths(&source).unwrap() {
            let bytes = read_sync_bytes(&source, &path).unwrap();
            zip.start_file(&path, options).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap();

        let dest = root.join("dest");
        write(&dest.join(BOOK_FILE), r#"{"title":"旧书","kind":"comic","createdAt":1}"#);
        let (applied, manifest) = apply_package(Some(&dest), &pack).unwrap();
        assert_eq!(applied, dest);
        assert!(dest.join("comic/pages/p_1/page.json").is_file());
        assert!(dest.join("comic/pages/p_1/layers/l_1.png").is_file());
        assert!(manifest.files.iter().any(|f| f.path == "comic/pages/p_1/page.json"));
        let _ = fs::remove_dir_all(&root);
    }
}
