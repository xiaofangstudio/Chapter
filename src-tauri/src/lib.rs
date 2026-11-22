//! Chapter 后端：工程读写、快照、字数统计与 TXT / Markdown / EPUB 3 导出。
//! 零联网、零遥测、零 AI；所有文件都在本机，正文不上传。

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

const BOOK_FILE: &str = "book.json";
const OUTLINE_FILE: &str = "outline.json";
const LORE_FILE: &str = "lore.json";

// ───────────────────────── 小工具 ─────────────────────────

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn config_dir() -> PathBuf {
    if let Some(p) = std::env::var_os("APPDATA") {
        return PathBuf::from(p).join("studio.xiaofang.chapter");
    }
    if let Some(p) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(p).join("studio.xiaofang.chapter");
    }
    home().join(".config").join("studio.xiaofang.chapter")
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn default_library() -> PathBuf {
    home().join("Documents").join("Chapter")
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

fn load_library() -> PathBuf {
    let sp = settings_path();
    if let Ok(text) = fs::read_to_string(&sp) {
        if let Ok(v) = serde_json::from_str::<Value>(&text) {
            if let Some(dir) = v.get("libraryDir").and_then(|d| d.as_str()) {
                if !dir.trim().is_empty() {
                    return PathBuf::from(dir);
                }
            }
        }
    }
    default_library()
}

fn save_library(dir: &Path) -> Result<(), String> {
    let sp = settings_path();
    if let Some(parent) = sp.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("建配置目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(&json!({ "libraryDir": dir.to_string_lossy() }))
        .map_err(|e| format!("配置序列化失败：{e}"))?;
    fs::write(&sp, text.as_bytes()).map_err(|e| format!("写配置失败：{e}"))
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(path).map_err(|e| format!("建目录失败（{}）：{e}", path.display()))
}

fn read_text(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("读取失败（{}）：{e}", path.display()))
}

fn write_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    fs::write(path, text.as_bytes()).map_err(|e| format!("写入失败（{}）：{e}", path.display()))
}

fn write_json(path: &Path, text: &str) -> Result<(), String> {
    // 先校验 JSON，坏掉的文本绝不落盘
    let v: Value = serde_json::from_str(text).map_err(|e| format!("JSON 格式错误：{e}"))?;
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| format!("JSON 序列化失败：{e}"))?;
    write_text(path, &pretty)
}

fn read_json_value(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(t) => serde_json::from_str(&t).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

fn sanitize_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if "<>:/\\|?*\"".contains(c) || c == '.' {
            out.push('_');
        } else if c.is_control() {
            continue;
        } else {
            out.push(c);
        }
    }
    let trimmed = out.trim().trim_matches('_').trim();
    if trimmed.is_empty() {
        "未命名".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

// ───────────────────────── 字数 ─────────────────────────

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF |
        0x3040..=0x30FF | 0xAC00..=0xD7AF)
}

/// 中文按字计，拉丁按词计，标点与空白不计。
pub fn count_words(text: &str) -> u64 {
    let mut count = 0u64;
    let mut in_word = false;
    for c in text.chars() {
        if is_cjk(c) {
            count += 1;
            in_word = false;
        } else if c.is_alphanumeric() {
            if !in_word {
                count += 1;
                in_word = true;
            }
        } else {
            in_word = false;
        }
    }
    count
}

/// 中文阅读习惯：估算阅读时间（每分钟 400 字）。
pub fn reading_minutes(words: u64) -> u64 {
    (words + 399) / 400
}
// ───────────────────────── 工程 ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChapterPayload {
    id: String,
    body: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectPayload {
    path: String,
    book: String,
    outline: String,
    lore: String,
    chapters: Vec<ChapterPayload>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotInfo {
    name: String,
    created_at: i64,
    words: u64,
    label: String,
}

fn chapters_dir(project: &Path) -> PathBuf {
    project.join("chapters")
}

fn default_outline() -> Value {
    let ms = now_ms();
    json!({
        "volumes": [
            {
                "id": format!("v_{ms}"),
                "title": "第一卷",
                "collapsed": false,
                "chapters": [
                    {
                        "id": format!("c_{ms}"),
                        "title": "第一章",
                        "summary": "",
                        "scenes": [],
                        "words": 0,
                        "updatedAt": ms
                    }
                ]
            }
        ]
    })
}

fn split_front_matter(text: &str) -> (&str, &str) {
    // 头信息：首行 ---，随后是 key: value，再一行 ---，之后才是正文
    if text.starts_with("---\n") {
        if let Some(idx) = text[4..].find("\n---\n") {
            let head_end = 4 + idx + 5;
            let body = &text[head_end..];
            return (&text[..head_end], body);
        }
        if let Some(idx) = text[4..].find("\n---") {
            let head_end = 4 + idx + 4;
            let body = if text.len() > head_end + 1 {
                &text[head_end + 1..]
            } else {
                ""
            };
            return (&text[..head_end], body);
        }
    }
    ("", text)
}

fn read_chapter_body(path: &Path) -> String {
    match fs::read_to_string(path) {
        Ok(t) => {
            let (_, body) = split_front_matter(&t);
            body.trim_start_matches('\n').to_string()
        }
        Err(_) => String::new(),
    }
}

fn write_chapter_body(path: &Path, id: &str, title: &str, body: &str) -> Result<(), String> {
    let clean_title = title.replace('\n', " ");
    let header = format!(
        "---\nid: {id}\ntitle: {clean_title}\nupdated: {}\n---\n\n",
        now_ms()
    );
    write_text(path, &format!("{header}{}", body.trim_end()))
}

fn ensure_project(project: &Path) -> Result<(), String> {
    if !project.is_dir() {
        return Err("找不到这本书的工程目录".into());
    }
    ensure_dir(&chapters_dir(project))?;
    ensure_dir(&project.join("snapshots"))?;
    ensure_dir(&project.join("assets"))?;

    if !project.join(BOOK_FILE).exists() {
        let folder = project
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未命名".into());
        let book = json!({
            "id": format!("b_{}", now_ms()),
            "title": folder,
            "author": "",
            "cover": Value::Null,
            "createdAt": now_ms(),
            "updatedAt": now_ms(),
            "targetWords": 200000,
            "dailyGoal": 2000,
            "lastChapterId": Value::Null,
            "daily": Value::Null
        });
        write_json(&project.join(BOOK_FILE), &serde_json::to_string(&book).unwrap())?;
    }
    if !project.join(OUTLINE_FILE).exists() {
        let outline = default_outline();
        write_json(&project.join(OUTLINE_FILE), &serde_json::to_string(&outline).unwrap())?;
        if let Some(ch) = outline["volumes"][0]["chapters"][0]["id"].as_str() {
            write_chapter_body(
                &chapters_dir(project).join(format!("{ch}.md")),
                ch,
                "第一章",
                "",
            )?;
        }
    }
    if !project.join(LORE_FILE).exists() {
        write_json(&project.join(LORE_FILE), "{\"entries\":[]}")?;
    }
    Ok(())
}

fn load_project(project: &Path) -> Result<ProjectPayload, String> {
    ensure_project(project)?;
    let mut chapters: Vec<ChapterPayload> = Vec::new();
    if let Ok(entries) = fs::read_dir(chapters_dir(project)) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let id = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if id.is_empty() {
                continue;
            }
            chapters.push(ChapterPayload {
                id: id.clone(),
                body: read_chapter_body(&path),
            });
        }
    }
    chapters.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(ProjectPayload {
        path: project.to_string_lossy().to_string(),
        book: read_text(&project.join(BOOK_FILE)).unwrap_or_else(|_| "{}".into()),
        outline: read_text(&project.join(OUTLINE_FILE)).unwrap_or_else(|_| "{}".into()),
        lore: read_text(&project.join(LORE_FILE)).unwrap_or_else(|_| "{\"entries\":[]}".into()),
        chapters,
    })
}

// ───────────────────────── 命令：书架 ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BookSummary {
    path: String,
    title: String,
    author: String,
    words: u64,
    updated_at: i64,
    cover: Option<String>,
    target_words: u64,
    id: String,
    chapter_count: usize,
    spine_color: Option<String>,
    cover_style: Option<String>,
    cover_mode: Option<String>,
}

fn summarize_book(dir: &Path) -> Option<BookSummary> {
    let book = read_json_value(&dir.join(BOOK_FILE));
    if book.is_null() {
        return None;
    }
    let title = book.get("title").and_then(|v| v.as_str()).unwrap_or("未命名");
    let author = book.get("author").and_then(|v| v.as_str()).unwrap_or("");
    let words = book.get("wordCount").and_then(|v| v.as_u64()).unwrap_or(0);
    let updated_at = book
        .get("updatedAt")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let target_words = book
        .get("targetWords")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let id = book.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let spine_color = book
        .get("spineColor")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let cover_style = book
        .get("coverStyle")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let cover_mode = book
        .get("coverMode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let cover = book.get("cover").and_then(|v| v.as_str()).map(|rel| {
        dir.join(rel).to_string_lossy().to_string()
    });
    let outline = read_json_value(&dir.join(OUTLINE_FILE));
    let chapter_count = outline
        .get("volumes")
        .and_then(|v| v.as_array())
        .map(|vols| {
            vols.iter()
                .map(|v| {
                    v.get("chapters")
                        .and_then(|c| c.as_array())
                        .map(|c| c.len())
                        .unwrap_or(0)
                })
                .sum()
        })
        .unwrap_or(0);
    Some(BookSummary {
        path: dir.to_string_lossy().to_string(),
        title: title.to_string(),
        author: author.to_string(),
        words,
        updated_at,
        cover,
        target_words,
        id,
        chapter_count,
        spine_color,
        cover_style,
        cover_mode,
    })
}

#[tauri::command]
fn get_library() -> Result<String, String> {
    let dir = load_library();
    ensure_dir(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn set_library(dir: String) -> Result<String, String> {
    let p = PathBuf::from(dir.trim());
    if p.as_os_str().is_empty() {
        return Err("目录不能为空".into());
    }
    ensure_dir(&p)?;
    save_library(&p)?;
    Ok(p.to_string_lossy().to_string())
}

#[tauri::command]
fn list_books() -> Result<Vec<BookSummary>, String> {
    let lib = load_library();
    ensure_dir(&lib)?;
    let mut books = Vec::new();
    if let Ok(entries) = fs::read_dir(&lib) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("chapter") {
                continue;
            }
            if let Some(sum) = summarize_book(&path) {
                books.push(sum);
            }
        }
    }
    books.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(books)
}

#[tauri::command]
fn create_book(
    title: String,
    author: String,
    target: u64,
    goal: u64,
) -> Result<ProjectPayload, String> {
    let lib = load_library();
    ensure_dir(&lib)?;
    let base = sanitize_name(&title);
    let mut name = format!("{base}.chapter");
    let mut n = 2;
    while lib.join(&name).exists() {
        name = format!("{base} {n}.chapter");
        n += 1;
    }
    let dir = lib.join(&name);
    ensure_dir(&dir)?;
    let ms = now_ms();
    let book = json!({
        "id": format!("b_{ms}"),
        "title": title.trim(),
        "author": author.trim(),
        "cover": Value::Null,
        "createdAt": ms,
        "updatedAt": ms,
        "targetWords": if target > 0 { target } else { 200000 },
        "dailyGoal": if goal > 0 { goal } else { 2000 },
        "lastChapterId": Value::Null,
        "daily": Value::Null,
        "wordCount": 0
    });
    write_json(&dir.join(BOOK_FILE), &serde_json::to_string(&book).unwrap())?;
    let outline = default_outline();
    write_json(&dir.join(OUTLINE_FILE), &serde_json::to_string(&outline).unwrap())?;
    write_json(&dir.join(LORE_FILE), "{\"entries\":[]}")?;
    ensure_dir(&chapters_dir(&dir))?;
    ensure_dir(&dir.join("snapshots"))?;
    ensure_dir(&dir.join("assets"))?;
    let cid = outline["volumes"][0]["chapters"][0]["id"]
        .as_str()
        .unwrap_or("c_1")
        .to_string();
    write_chapter_body(
        &chapters_dir(&dir).join(format!("{cid}.md")),
        &cid,
        "第一章",
        "",
    )?;
    load_project(&dir)
}

#[tauri::command]
fn open_book(path: String) -> Result<ProjectPayload, String> {
    let p = PathBuf::from(&path);
    load_project(&p)
}

#[tauri::command]
fn save_json(path: String, file: String, json: String) -> Result<(), String> {
    let name = match file.as_str() {
        "book.json" | "outline.json" | "lore.json" => file,
        _ => return Err("不允许写入该文件".into()),
    };
    let dir = PathBuf::from(&path);
    ensure_project(&dir)?;
    write_json(&dir.join(name), &json)
}

#[tauri::command]
fn save_chapter(path: String, chapter: String, title: String, body: String) -> Result<u64, String> {
    if !chapter
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("章节 id 非法".into());
    }
    let dir = PathBuf::from(&path);
    ensure_project(&dir)?;
    let file = chapters_dir(&dir).join(format!("{chapter}.md"));
    write_chapter_body(&file, &chapter, &title, &body)?;
    Ok(count_words(&body))
}

#[tauri::command]
fn read_chapter(path: String, chapter: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    let file = chapters_dir(&dir).join(format!("{chapter}.md"));
    Ok(read_chapter_body(&file))
}

/// 删章不销毁稿件：改成 .md.deleted，仍可在工程目录里找回。
#[tauri::command]
fn delete_chapter(path: String, chapter: String) -> Result<(), String> {
    if !chapter
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("章节 id 非法".into());
    }
    let dir = PathBuf::from(&path);
    let file = chapters_dir(&dir).join(format!("{chapter}.md"));
    if file.is_file() {
        let target = chapters_dir(&dir).join(format!("{chapter}.md.deleted"));
        fs::rename(&file, &target).map_err(|e| format!("删除章节失败：{e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn delete_book(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_dir() {
        return Err("这本书已经不在书架上".into());
    }
    let lib = load_library();
    let trash = lib.join(".回收站");
    ensure_dir(&trash)?;
    let folder = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "book.chapter".into());
    let target = trash.join(format!("{folder}-{}", now_ms()));
    fs::rename(&p, &target).map_err(|e| format!("移到回收站失败：{e}"))?;
    Ok(())
}

/// 封面统一写入点：复制到书籍目录、清掉旧副本、更新 book.json。
/// GUI 的裁切结果和 MCP 传入的图片文件都走这里，避免两套落盘行为。
fn install_cover(dir: &Path, bytes: &[u8], ext: &str) -> Result<String, String> {
    let assets = dir.join("assets");
    ensure_dir(&assets)?;
    if let Ok(entries) = fs::read_dir(&assets) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("cover.") {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    let rel = format!("assets/cover.{ext}");
    fs::write(dir.join(&rel), bytes).map_err(|e| format!("复制封面失败：{e}"))?;
    let mut book = read_json_value(&dir.join(BOOK_FILE));
    if book.is_null() {
        book = json!({});
    }
    book["cover"] = json!(rel);
    book["updatedAt"] = json!(now_ms());
    write_json(&dir.join(BOOK_FILE), &serde_json::to_string(&book).unwrap())?;
    Ok(rel)
}

#[tauri::command]
fn set_cover(path: String, source: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    let src = PathBuf::from(&source);
    if !src.is_file() {
        return Err("找不到这张图片".into());
    }
    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "png".into());
    let ext = match ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => ext,
        _ => return Err("封面支持 PNG / JPG / WEBP / GIF / BMP".into()),
    };
    let bytes = fs::read(&src).map_err(|e| format!("读取封面失败：{e}"))?;
    install_cover(&dir, &bytes, &ext)
}

#[tauri::command]
fn set_cover_image(path: String, data_url: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    let (meta, data) = data_url
        .split_once(',')
        .ok_or_else(|| "封面数据格式不正确".to_string())?;
    if !meta.contains(";base64") {
        return Err("封面数据格式不正确".into());
    }
    let ext = if meta.contains("image/jpeg") || meta.contains("image/jpg") {
        "jpg"
    } else if meta.contains("image/webp") {
        "webp"
    } else {
        "png"
    };
    let bytes = B64
        .decode(data)
        .map_err(|e| format!("封面数据解码失败：{e}"))?;
    install_cover(&dir, &bytes, ext)
}

#[tauri::command]
fn cover_data(path: String, rel: String) -> Result<Option<String>, String> {
    let file = PathBuf::from(&path).join(&rel);
    if !file.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(&file).map_err(|e| format!("读取封面失败：{e}"))?;
    let mime = match file
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/jpeg",
    };
    Ok(Some(format!("data:{mime};base64,{}", B64.encode(bytes))))
}

// ───────────────────────── 快照 ─────────────────────────

fn snapshot_root(project: &Path) -> PathBuf {
    project.join("snapshots")
}

fn snapshot_words(project: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(chapters_dir(project)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("md") {
                total += count_words(&read_chapter_body(&p));
            }
        }
    }
    total
}

fn prune_snapshots(project: &Path, keep: usize) {
    let root = snapshot_root(project);
    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                names.push(e.file_name().to_string_lossy().to_string());
            }
        }
    }
    names.sort();
    names.reverse();
    for name in names.into_iter().skip(keep) {
        let _ = fs::remove_dir_all(root.join(name));
    }
}

#[tauri::command]
fn create_snapshot(path: String, label: String) -> Result<Vec<SnapshotInfo>, String> {
    let dir = PathBuf::from(&path);
    ensure_project(&dir)?;
    let root = snapshot_root(&dir);
    ensure_dir(&root)?;
    let name = now_ms().to_string();
    let snap = root.join(&name);
    ensure_dir(&snap)?;
    for f in [BOOK_FILE, OUTLINE_FILE, LORE_FILE] {
        let src = dir.join(f);
        if src.is_file() {
            let _ = fs::copy(&src, snap.join(f));
        }
    }
    ensure_dir(&snap.join("chapters"))?;
    if let Ok(entries) = fs::read_dir(chapters_dir(&dir)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("md") {
                let _ = fs::copy(&p, snap.join("chapters").join(e.file_name()));
            }
        }
    }
    let meta = json!({
        "createdAt": now_ms(),
        "label": label,
        "words": snapshot_words(&dir)
    });
    let _ = write_json(&snap.join("meta.json"), &serde_json::to_string(&meta).unwrap());
    prune_snapshots(&dir, 20);
    list_snapshots(path)
}

#[tauri::command]
fn list_snapshots(path: String) -> Result<Vec<SnapshotInfo>, String> {
    let dir = PathBuf::from(&path);
    let root = snapshot_root(&dir);
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&root) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let meta = read_json_value(&p.join("meta.json"));
            let created = meta
                .get("createdAt")
                .and_then(|v| v.as_i64())
                .unwrap_or_else(|| name.parse::<i64>().unwrap_or(0));
            let label = meta
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let words = meta
                .get("words")
                .and_then(|v| v.as_u64())
                .unwrap_or_else(|| snapshot_words(&p));
            out.push(SnapshotInfo {
                name,
                created_at: created,
                words,
                label,
            });
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
fn restore_snapshot(path: String, name: String) -> Result<ProjectPayload, String> {
    let dir = PathBuf::from(&path);
    if !name.chars().all(|c| c.is_ascii_digit()) {
        return Err("快照名称非法".into());
    }
    let snap = snapshot_root(&dir).join(&name);
    if !snap.is_dir() {
        return Err("找不到这个快照".into());
    }
    // 恢复前先给当前状态存一份，避免误点丢稿
    let _ = create_snapshot(path.clone(), "恢复前自动备份".into());
    for f in [BOOK_FILE, OUTLINE_FILE, LORE_FILE] {
        let src = snap.join(f);
        if src.is_file() {
            fs::copy(&src, dir.join(f)).map_err(|e| format!("恢复失败：{e}"))?;
        }
    }
    if let Ok(entries) = fs::read_dir(chapters_dir(&dir)) {
        for e in entries.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) == Some("md") {
                let _ = fs::remove_file(e.path());
            }
        }
    }
    ensure_dir(&chapters_dir(&dir))?;
    if let Ok(entries) = fs::read_dir(snap.join("chapters")) {
        for e in entries.flatten() {
            if e.path().extension().and_then(|x| x.to_str()) == Some("md") {
                fs::copy(e.path(), chapters_dir(&dir).join(e.file_name()))
                    .map_err(|e| format!("恢复失败：{e}"))?;
            }
        }
    }
    load_project(&dir)
}

// ───────────────────────── 导出：Markdown / TXT ─────────────────────────

#[derive(Deserialize, Default)]
struct OutlineChapter {
    id: String,
    #[serde(default)]
    title: String,
}

#[derive(Deserialize, Default)]
struct OutlineVolume {
    #[serde(default)]
    title: String,
    #[serde(default)]
    chapters: Vec<OutlineChapter>,
}

#[derive(Deserialize, Default)]
struct Outline {
    #[serde(default)]
    volumes: Vec<OutlineVolume>,
}

fn load_outline(project: &Path) -> Outline {
    let text = fs::read_to_string(project.join(OUTLINE_FILE)).unwrap_or_default();
    serde_json::from_str(&text).unwrap_or_default()
}

fn strip_inline(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '*' {
            if chars.peek() == Some(&'*') {
                chars.next();
            }
            continue;
        }
        if c == '`' || c == '~' {
            continue;
        }
        out.push(c);
    }
    out
}

fn strip_md_links(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(pos) = rest.find('[') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let image = tail.starts_with("![");
        let label_start = if image { 2 } else { 1 };
        let close = match tail.find("](") {
            Some(c) if c >= label_start => c,
            _ => {
                out.push('[');
                rest = &tail[1..];
                continue;
            }
        };
        let after = &tail[close + 2..];
        let end = match after.find(')') {
            Some(e) => e,
            None => {
                out.push('[');
                rest = &tail[1..];
                continue;
            }
        };
        out.push_str(&tail[label_start..close]);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// TXT 用的纯文本化：标题、引用、列表、链接、图片、行内标记全部转成可读文字。
fn strip_md_plain_line(line: &str) -> String {
    let mut t = line.trim_end().to_string();
    if t.trim_start().starts_with("```") || t.trim_start().starts_with("~~~") {
        return String::new();
    }
    t = strip_md_links(&t);
    let trimmed = t.trim_start();
    let hashes = trimmed.chars().take_while(|c| *c == '#').count();
    let body = if hashes > 0 && hashes <= 6 {
        trimmed[hashes..].trim_start()
    } else {
        trimmed
    };
    let body = body.strip_prefix("> ").unwrap_or(body);
    let body = if body.trim() == "---" || body.trim() == "***" || body.trim() == "___" {
        ""
    } else if let Some(rest) = body.strip_prefix("- ") {
        rest
    } else if let Some(rest) = body.strip_prefix("* ") {
        rest
    } else {
        body
    };
    strip_inline(&strip_md_links(body))
}

fn strip_md_body(md: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in md.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() {
            lines.push(String::new());
            continue;
        }
        if t.starts_with('>') {
            lines.push(format!("　　{}", strip_md_plain_line(t.trim_start_matches('>').trim())));
        } else if t.trim() == "---" || t.trim() == "***" || t.trim() == "___" {
            lines.push(String::new());
        } else if t.starts_with("- ") || t.starts_with("* ") {
            lines.push(format!("· {}", strip_md_plain_line(t[2..].trim())));
        } else {
            let ordered = t
                .split_once(". ")
                .filter(|(n, _)| n.chars().all(|c| c.is_ascii_digit()) && !n.is_empty())
                .map(|(n, rest)| format!("{n}. {}", strip_md_plain_line(rest.trim())));
            match ordered {
                Some(x) => lines.push(x),
                None => lines.push(strip_md_plain_line(t)),
            }
        }
    }
    let joined = lines.join("\n");
    format!("{}\n", joined.trim_matches('\n'))
}

fn build_markdown(project: &Path, title: &str, author: &str, plain: bool) -> String {
    let outline = load_outline(project);
    let book = read_json_value(&project.join(BOOK_FILE));
    let front = book
        .get("frontMatter")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let back = book
        .get("backMatter")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let mut out = if plain {
        format!("{}\n\n", title)
    } else {
        format!("# {}\n\n", title)
    };
    if !author.trim().is_empty() {
        if plain {
            out.push_str(&format!("作者：{}\n\n", author.trim()));
        } else {
            out.push_str(&format!("> 作者：{}\n\n", author.trim()));
        }
    }
    if !front.is_empty() {
        if plain {
            out.push_str(&strip_md_body(&front));
        } else {
            out.push_str(&front);
        }
        out.push_str("\n\n");
    }
    for vol in &outline.volumes {
        if !vol.title.trim().is_empty() {
            if plain {
                out.push_str(&format!("{}\n\n", vol.title.trim()));
            } else {
                out.push_str(&format!("## {}\n\n", vol.title.trim()));
            }
        }
        for ch in &vol.chapters {
            let body = read_chapter_body(&chapters_dir(project).join(format!("{}.md", ch.id)));
            if plain {
                out.push_str(&format!("{}\n\n", ch.title.trim()));
            } else {
                out.push_str(&format!("### {}\n\n", ch.title.trim()));
            }
            let content = if plain {
                strip_md_body(&body)
            } else {
                format!("{}\n", body.trim())
            };
            if !content.trim().is_empty() {
                out.push_str(&content);
                out.push('\n');
            }
        }
    }
    if !back.is_empty() {
        if plain {
            out.push_str(&strip_md_body(&back));
        } else {
            out.push_str(&back);
        }
        out.push('\n');
    }
    out
}

// ───────────────────────── 导出：EPUB 3 ─────────────────────────

fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn md_inline(s: &str) -> String {
    let mut out = String::new();
    let mut buf = String::new();
    let mut bold = false;
    let mut ital = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '*' {
            if chars.peek() == Some(&'*') {
                chars.next();
                out.push_str(&xml_escape(&buf));
                buf.clear();
                out.push_str(if bold { "</strong>" } else { "<strong>" });
                bold = !bold;
            } else {
                out.push_str(&xml_escape(&buf));
                buf.clear();
                out.push_str(if ital { "</em>" } else { "<em>" });
                ital = !ital;
            }
        } else {
            buf.push(c);
        }
    }
    out.push_str(&xml_escape(&buf));
    if ital {
        out.push_str("</em>");
    }
    if bold {
        out.push_str("</strong>");
    }
    out
}

fn md_to_xhtml(md: &str) -> String {
    let mut out = String::new();
    let mut para: Vec<String> = Vec::new();
    let mut list: Option<(String, Vec<String>)> = None;
    let mut quote: Vec<String> = Vec::new();

    fn flush_para(out: &mut String, para: &mut Vec<String>) {
        if para.is_empty() {
            return;
        }
        let text = para
            .iter()
            .map(|l| md_inline(l))
            .collect::<Vec<_>>()
            .join("<br/>");
        out.push_str(&format!("<p>{text}</p>\n"));
        para.clear();
    }
    fn flush_list(out: &mut String, list: &mut Option<(String, Vec<String>)>) {
        if let Some((kind, items)) = list.take() {
            if !items.is_empty() {
                out.push_str(&format!("<{kind}>\n"));
                for it in items {
                    out.push_str(&format!("<li>{}</li>\n", md_inline(&it)));
                }
                out.push_str(&format!("</{kind}>\n"));
            }
        }
    }
    fn flush_quote(out: &mut String, quote: &mut Vec<String>) {
        if quote.is_empty() {
            return;
        }
        let text = quote
            .iter()
            .map(|l| md_inline(l))
            .collect::<Vec<_>>()
            .join("<br/>");
        out.push_str(&format!("<blockquote><p>{text}</p></blockquote>\n"));
        quote.clear();
    }

    for raw in md.lines() {
        let t = raw.trim_end();
        let trimmed = t.trim();
        if trimmed.is_empty() {
            flush_para(&mut out, &mut para);
            flush_list(&mut out, &mut list);
            flush_quote(&mut out, &mut quote);
            continue;
        }
        if trimmed == "---" || trimmed == "***" {
            flush_para(&mut out, &mut para);
            flush_list(&mut out, &mut list);
            flush_quote(&mut out, &mut quote);
            out.push_str("<hr/>\n");
            continue;
        }
        if let Some(rest) = t.strip_prefix("> ") {
            flush_para(&mut out, &mut para);
            flush_list(&mut out, &mut list);
            quote.push(rest.trim().to_string());
            continue;
        }
        if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) {
            flush_para(&mut out, &mut para);
            flush_quote(&mut out, &mut quote);
            match &mut list {
                Some((kind, items)) if kind == "ul" => items.push(rest.trim().to_string()),
                _ => {
                    flush_list(&mut out, &mut list);
                    list = Some(("ul".into(), vec![rest.trim().to_string()]));
                }
            }
            continue;
        }
        if let Some((num, rest)) = t.split_once(". ") {
            if num.chars().all(|c| c.is_ascii_digit()) && !num.is_empty() {
                flush_para(&mut out, &mut para);
                flush_quote(&mut out, &mut quote);
                match &mut list {
                    Some((kind, items)) if kind == "ol" => items.push(rest.trim().to_string()),
                    _ => {
                        flush_list(&mut out, &mut list);
                        list = Some(("ol".into(), vec![rest.trim().to_string()]));
                    }
                }
                continue;
            }
        }
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if hashes > 0 && hashes <= 6 && trimmed[hashes..].starts_with(' ') {
            flush_para(&mut out, &mut para);
            flush_list(&mut out, &mut list);
            flush_quote(&mut out, &mut quote);
            let level = (hashes + 1).min(6);
            out.push_str(&format!(
                "<h{level}>{}</h{level}>\n",
                md_inline(trimmed[hashes..].trim())
            ));
            continue;
        }
        flush_list(&mut out, &mut list);
        flush_quote(&mut out, &mut quote);
        para.push(t.to_string());
    }
    flush_para(&mut out, &mut para);
    flush_list(&mut out, &mut list);
    flush_quote(&mut out, &mut quote);
    out
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn iso_utc(ms: i64) -> String {
    let secs = ms.max(0) / 1000;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn add_zip_file(
    zip: &mut ZipWriter<File>,
    name: &str,
    data: &[u8],
    compression: CompressionMethod,
) -> Result<(), String> {
    let opts = SimpleFileOptions::default().compression_method(compression);
    zip.start_file(name, opts)
        .map_err(|e| format!("打包失败（{name}）：{e}"))?;
    zip.write_all(data)
        .map_err(|e| format!("写入失败（{name}）：{e}"))
}

fn find_cover(project: &Path) -> Option<PathBuf> {
    let assets = project.join("assets");
    let entries = fs::read_dir(assets).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_lowercase();
        if name.starts_with("cover.") && p.is_file() {
            return Some(p);
        }
    }
    None
}

fn build_epub(project: &Path, dest: &Path, title: &str, author: &str) -> Result<String, String> {
    let outline = load_outline(project);
    let mut flat: Vec<(String, String, String)> = Vec::new(); // 卷名, 章名, 正文
    for vol in &outline.volumes {
        for ch in &vol.chapters {
            let body = read_chapter_body(&chapters_dir(project).join(format!("{}.md", ch.id)));
            flat.push((vol.title.clone(), ch.title.clone(), body));
        }
    }
    if flat.is_empty() {
        return Err("这本书还没有章节".into());
    }

    let file = File::create(dest).map_err(|e| format!("创建 EPUB 失败：{e}"))?;
    let mut zip = ZipWriter::new(file);

    // EPUB 规范：mimetype 必须是第一个文件，且不压缩
    add_zip_file(
        &mut zip,
        "mimetype",
        b"application/epub+zip",
        CompressionMethod::Stored,
    )?;

    add_zip_file(
        &mut zip,
        "META-INF/container.xml",
        br#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#,
        CompressionMethod::Deflated,
    )?;

    let css = r#"@charset "utf-8";
html, body { margin: 0; padding: 0; }
body { font-family: "Songti SC", "Source Han Serif SC", "SimSun", serif; line-height: 1.92; color: #2b2117; background: #fffdf8; padding: 1.6em 1.4em; text-align: justify; }
h2 { font-size: 1.35em; margin: 1.2em 0 1em; padding-bottom: .5em; border-bottom: 1px solid #e8dcc8; letter-spacing: .04em; }
h3, h4 { font-size: 1.08em; margin: 1.2em 0 .6em; }
p { margin: 0 0 .72em; text-indent: 2em; }
blockquote { margin: 1em 0; padding: .4em 1em; border-left: 3px solid #c96a1f; color: #6b5c4b; font-style: italic; }
hr { border: 0; border-top: 1px solid #e8dcc8; margin: 1.4em 2em; }
ul, ol { margin: .6em 0 .9em 1.6em; }
.title-page { text-align: center; padding-top: 22%; }
.title-page h1 { font-size: 2.2em; letter-spacing: .06em; margin-bottom: 1.4em; }
.title-page .author { color: #6b5c4b; font-size: 1em; }
.cover { text-align: center; padding: 0; margin: 0; }
.cover img { max-width: 100%; max-height: 100%; }
"#;
    add_zip_file(
        &mut zip,
        "OEBPS/style.css",
        css.as_bytes(),
        CompressionMethod::Deflated,
    )?;

    let mut manifest = String::new();
    let mut spine = String::new();
    let book = read_json_value(&project.join(BOOK_FILE));
    let front = book
        .get("frontMatter")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let back = book
        .get("backMatter")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    if !front.is_empty() {
        let page = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>前言</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h2>前言</h2>{}</body></html>"#,
            md_to_xhtml(&front)
        );
        add_zip_file(
            &mut zip,
            "OEBPS/front.xhtml",
            page.as_bytes(),
            CompressionMethod::Deflated,
        )?;
        manifest.push_str("    <item id=\"front\" href=\"front.xhtml\" media-type=\"application/xhtml+xml\"/>\n");
        spine.push_str("    <itemref idref=\"front\"/>\n");
    }

    for (i, (_vol, ch_title, body)) in flat.iter().enumerate() {
        let name = format!("chap_{:03}.xhtml", i + 1);
        let page = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>{}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h2>{}</h2>
{}
</body></html>"#,
            xml_escape(ch_title),
            xml_escape(ch_title),
            md_to_xhtml(body)
        );
        add_zip_file(
            &mut zip,
            &format!("OEBPS/{name}"),
            page.as_bytes(),
            CompressionMethod::Deflated,
        )?;
        manifest.push_str(&format!(
            "    <item id=\"c{}\" href=\"{}\" media-type=\"application/xhtml+xml\"/>\n",
            i + 1,
            name
        ));
        spine.push_str(&format!("    <itemref idref=\"c{}\"/>\n", i + 1));
    }

    // 目录：卷分组 + 章链接
    if !back.is_empty() {
        let page = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>后记</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><h2>后记</h2>{}</body></html>"#,
            md_to_xhtml(&back)
        );
        add_zip_file(
            &mut zip,
            "OEBPS/back.xhtml",
            page.as_bytes(),
            CompressionMethod::Deflated,
        )?;
        manifest.push_str("    <item id=\"back\" href=\"back.xhtml\" media-type=\"application/xhtml+xml\"/>\n");
        spine.push_str("    <itemref idref=\"back\"/>\n");
    }

    // 目录：卷分组 + 章链接
    let mut nav_body = String::new();
    if !front.is_empty() {
        nav_body.push_str("    <li><a href=\"front.xhtml\">前言</a></li>\n");
    }
    let mut index = 0usize;
    for vol in &outline.volumes {
        let chapters: Vec<&OutlineChapter> = vol.chapters.iter().collect();
        if chapters.is_empty() {
            continue;
        }
        let vol_title = vol.title.trim();
        if !vol_title.is_empty() {
            nav_body.push_str(&format!(
                "    <li><span>{}</span>\n      <ul>\n",
                xml_escape(vol_title)
            ));
            for _ in &chapters {
                let ch_title = &flat[index].1;
                nav_body.push_str(&format!(
                    "        <li><a href=\"chap_{:03}.xhtml\">{}</a></li>\n",
                    index + 1,
                    xml_escape(ch_title)
                ));
                index += 1;
            }
            nav_body.push_str("      </ul>\n    </li>\n");
        } else {
            for _ in &chapters {
                let ch_title = &flat[index].1;
                nav_body.push_str(&format!(
                    "    <li><a href=\"chap_{:03}.xhtml\">{}</a></li>\n",
                    index + 1,
                    xml_escape(ch_title)
                ));
                index += 1;
            }
        }
    }
    let nav_page = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>目录</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h2>目录</h2>
<nav epub:type="toc" id="toc">
  <ul>
{nav_body}{back_nav}  </ul>
</nav>
</body></html>"#,
        back_nav = if back.is_empty() {
            String::new()
        } else {
            "    <li><a href=\"back.xhtml\">后记</a></li>\n".to_string()
        }
    );
    add_zip_file(
        &mut zip,
        "OEBPS/nav.xhtml",
        nav_page.as_bytes(),
        CompressionMethod::Deflated,
    )?;

    // 标题页
    let title_page = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>{}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><div class="title-page"><h1>{}</h1><div class="author">{}</div></div></body></html>"#,
        xml_escape(title),
        xml_escape(title),
        xml_escape(author)
    );
    add_zip_file(
        &mut zip,
        "OEBPS/title.xhtml",
        title_page.as_bytes(),
        CompressionMethod::Deflated,
    )?;

    let mut cover_manifest = String::new();
    let mut cover_spine = String::new();

    if let Some(cover_path) = find_cover(project) {
        let ext = cover_path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "jpg".into());
        let media = match ext.as_str() {
            "png" => "image/png",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            _ => "image/jpeg",
        };
        let bytes = fs::read(&cover_path).map_err(|e| format!("读取封面失败：{e}"))?;
        let img_name = format!("cover.{ext}");
        add_zip_file(
            &mut zip,
            &format!("OEBPS/images/{img_name}"),
            &bytes,
            CompressionMethod::Deflated,
        )?;
        cover_manifest.push_str(&format!(
            "    <item id=\"cover-image\" href=\"images/{img_name}\" media-type=\"{media}\" properties=\"cover-image\"/>\n"
        ));
        let cover_page = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="utf-8"/><title>封面</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body><div class="cover"><img src="images/{img_name}" alt="封面"/></div></body></html>"#
        );
        add_zip_file(
            &mut zip,
            "OEBPS/cover.xhtml",
            cover_page.as_bytes(),
            CompressionMethod::Deflated,
        )?;
        cover_manifest.push_str(
            "    <item id=\"cover-page\" href=\"cover.xhtml\" media-type=\"application/xhtml+xml\"/>\n",
        );
        cover_spine = "    <itemref idref=\"cover-page\"/>\n".into();
    }

    let identifier = read_json_value(&project.join(BOOK_FILE))
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| format!("urn:chapter:{s}"))
        .unwrap_or_else(|| format!("urn:chapter:{}", now_ms()));
    let modified = iso_utc(now_ms());

    let opf = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
    <dc:identifier id="bookid">{identifier}</dc:identifier>
    <dc:title>{title}</dc:title>
    <dc:creator>{author}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <dcterms:modified>{modified}</dcterms:modified>
    <meta property="dcterms:modified">{modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="title-page" href="title.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
{cover_manifest}{manifest}  </manifest>
  <spine>
{cover_spine}    <itemref idref="title-page"/>
{spine}  </spine>
</package>"#,
        identifier = xml_escape(&identifier),
        title = xml_escape(title),
        author = xml_escape(author),
        modified = modified,
    );
    add_zip_file(
        &mut zip,
        "OEBPS/content.opf",
        opf.as_bytes(),
        CompressionMethod::Deflated,
    )?;

    // 老阅读器兼容的 toc.ncx
    let mut ncx_points = String::new();
    for (i, (_, ch_title, _)) in flat.iter().enumerate() {
        ncx_points.push_str(&format!(
            r#"    <navPoint id="np{}" playOrder="{}"><navLabel><text>{}</text></navLabel><content src="chap_{:03}.xhtml"/></navPoint>
"#,
            i + 1,
            i + 1,
            xml_escape(ch_title),
            i + 1
        ));
    }
    let ncx = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="{}"/></head>
  <docTitle><text>{}</text></docTitle>
  <navMap>
{}  </navMap>
</ncx>"#,
        xml_escape(&identifier),
        xml_escape(title),
        ncx_points
    );
    add_zip_file(
        &mut zip,
        "OEBPS/toc.ncx",
        ncx.as_bytes(),
        CompressionMethod::Deflated,
    )?;

    zip.finish().map_err(|e| format!("收尾失败：{e}"))?;
    Ok(format!(
        "已导出 {} 章 · {} 字",
        flat.len(),
        flat.iter().map(|(_, _, b)| count_words(b)).sum::<u64>()
    ))
}

// ───────────────────────── 自打印：PDF / Word ─────────────────────────

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PrintBlock {
    kind: String,
    #[serde(default)]
    text: String,
    #[serde(default)]
    src: String,
    #[serde(default)]
    width: f64,
    #[serde(default)]
    height: f64,
    #[serde(default)]
    page_break: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrintDoc {
    paper: String,
    margin: String,
    font: String,
    font_size: f64,
    line_height: f64,
    indent: f64,
    #[serde(default)]
    chapter_break: bool,
    #[serde(default)]
    include_matter: bool,
    title: String,
    author: String,
    blocks: Vec<PrintBlock>,
}

fn print_paper_mm(name: &str) -> (f64, f64) {
    match name {
        "A5" => (148.0, 210.0),
        "B5" => (176.0, 250.0),
        "16K" => (184.0, 260.0),
        _ => (210.0, 297.0),
    }
}

fn print_margin_mm(name: &str) -> f64 {
    match name {
        "narrow" => 14.0,
        "wide" => 28.0,
        _ => 22.0,
    }
}

fn print_pdf_html(doc: &PrintDoc) -> String {
    let (pw, ph) = print_paper_mm(&doc.paper);
    let margin = print_margin_mm(&doc.margin);
    let family = if doc.font == "sans" {
        "\"Microsoft YaHei\",\"PingFang SC\",\"Noto Sans CJK SC\",sans-serif"
    } else {
        "\"Noto Serif CJK SC\",\"Songti SC\",\"SimSun\",serif"
    };
    let mut body = String::new();
    let mut i = 0usize;
    while i < doc.blocks.len() {
        let b = &doc.blocks[i];
        match b.kind.as_str() {
            "title" => {
                let mut author = String::new();
                if i + 1 < doc.blocks.len() && doc.blocks[i + 1].kind == "author" {
                    author = doc.blocks[i + 1].text.clone();
                    i += 1;
                }
                body.push_str(&format!(
                    "<div class=\"cover\"><div class=\"cover-title\">{}</div>{}{}<span>CHAPTER</span></div>",
                    xml_escape(&b.text),
                    if author.is_empty() {
                        String::new()
                    } else {
                        format!("<div class=\"cover-author\">{}</div>", xml_escape(&author))
                    },
                    ""
                ));
            }
            "author" => {}
            "pagebreak" => body.push_str("<div class=\"pagebreak\"></div>"),
            "heading" => body.push_str(&format!(
                "<h2 class=\"chapter{}\">{}</h2>",
                if b.page_break { " newpage" } else { "" },
                xml_escape(&b.text)
            )),
            "kicker" => body.push_str(&format!(
                "<h3 class=\"kicker\">{}</h3>",
                xml_escape(&b.text)
            )),
            "quote" => body.push_str(&format!("<blockquote>{}</blockquote>", xml_escape(&b.text))),
            "image" => body.push_str(&format!(
                "<img class=\"inline-img\" src=\"{}\" alt=\"\">",
                xml_escape(&b.src)
            )),
            _ => body.push_str(&format!("<p>{}</p>", xml_escape(&b.text))),
        }
        i += 1;
    }
    format!(
        "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>{}</title><style>\
         @page {{ size: {}mm {}mm; margin: {}mm; }}\
         * {{ box-sizing: border-box; }}\
         html, body {{ margin: 0; padding: 0; background: #fff; }}\
         body {{ font-family: {}; font-size: {}pt; line-height: {}; color: #24221e; text-align: justify; -webkit-print-color-adjust: exact; }}\
         .cover {{ height: {}mm; display: flex; flex-direction: column; align-items: center; justify-content: center; page-break-after: always; }}\
         .cover-title {{ font-size: {}pt; font-weight: 600; letter-spacing: 0.08em; line-height: 1.3; text-align: center; }}\
         .cover-author {{ margin-top: 8mm; font-size: {}pt; letter-spacing: 0.16em; color: #5d5750; }}\
         .cover span {{ margin-top: auto; font-size: 8pt; letter-spacing: 0.18em; color: #9a938a; }}\
         h2.chapter {{ font-size: {}pt; font-weight: 600; text-align: center; margin: 4mm 0 5mm; line-height: 1.35; letter-spacing: 0.05em; }}\
         h2.chapter.newpage {{ page-break-before: always; }}\
         h3.kicker {{ font-size: {}pt; font-weight: 500; text-align: center; color: #6a6258; margin: 2mm 0 3mm; }}\
         p {{ margin: 0 0 0.68em; text-indent: {}em; orphans: 2; widows: 2; }}\
         blockquote {{ margin: 0.6em 0; padding-left: 4mm; border-left: 0.6mm solid #b9afa2; color: #5e574f; }}\
         img.inline-img {{ display: block; max-width: 100%; margin: 3mm auto 4mm; }}\
         .pagebreak {{ page-break-after: always; height: 0; }}\
         </style></head><body>{}</body></html>",
        xml_escape(&doc.title),
        pw,
        ph,
        margin,
        family,
        doc.font_size,
        doc.line_height,
        ph - margin * 2.0,
        doc.font_size * 2.4,
        doc.font_size * 1.1,
        doc.font_size * 1.5,
        doc.font_size * 0.92,
        doc.indent,
        body
    )
}

fn edge_binary() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn print_pdf(doc: &PrintDoc, dest: &Path) -> Result<(), String> {
    let edge = edge_binary().ok_or("没有找到 Microsoft Edge，无法生成 PDF")?;
    let stamp = now_ms();
    let tmp = std::env::temp_dir().join(format!("chapter-print-{}", stamp));
    ensure_dir(&tmp)?;
    let html_path = tmp.join("print.html");
    write_text(&html_path, &print_pdf_html(doc))?;
    let file_url = format!(
        "file:///{}",
        html_path
            .to_string_lossy()
            .replace('\\', "/")
            .replace(' ', "%20")
    );
    let out = Command::new(edge)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--no-pdf-header-footer",
            "--print-to-pdf-no-header",
            &format!("--print-to-pdf={}", dest.to_string_lossy()),
            &file_url,
        ])
        .output()
        .map_err(|e| format!("启动 Edge 失败：{}", e))?;
    let _ = fs::remove_dir_all(&tmp);
    if !out.status.success() {
        let tail = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "PDF 生成失败：{}",
            tail.chars().rev().take(300).collect::<String>().chars().rev().collect::<String>()
        ));
    }
    let size = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    if size == 0 {
        return Err("PDF 生成失败：输出为空".into());
    }
    Ok(())
}

fn docx_run(text: &str, size: f64, bold: bool, italic: bool, font: &str) -> String {
    let font = if font == "sans" { "微软雅黑" } else { "宋体" };
    format!(
        "<w:r><w:rPr><w:rFonts w:ascii=\"{f}\" w:eastAsia=\"{f}\" w:hAnsi=\"{f}\"/>{} {} {}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
        size * 2.0,
        if bold { "<w:b/>" } else { "" },
        if italic { "<w:i/>" } else { "" },
        xml_escape(text),
        f = font,
    )
}

fn docx_p(
    inner: &str,
    align: &str,
    after: f64,
    line: f64,
    first_line_twips: f64,
    page_break: bool,
) -> String {
    format!(
        "<w:p><w:pPr>{}<w:jc w:val=\"{}\"/><w:spacing w:after=\"{}\" w:line=\"{}\" w:lineRule=\"auto\"/>{} </w:pPr>{}</w:p>",
        if page_break { "<w:pageBreakBefore/>" } else { "" },
        align,
        (after * 240.0) as i64,
        (line * 240.0) as i64,
        if first_line_twips > 0.0 {
            format!("<w:ind w:firstLine=\"{}\"/>", first_line_twips as i64)
        } else {
            String::new()
        },
        inner
    )
}

fn data_url_bytes(src: &str) -> Option<(Vec<u8>, String)> {
    let rest = src.strip_prefix("data:")?;
    let semi = rest.find(';')?;
    let mime = &rest[..semi];
    let b64 = rest.splitn(2, "base64,").nth(1)?;
    let ext = match mime {
        "image/jpeg" => "jpeg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "png",
    };
    B64.decode(b64).ok().map(|b| (b, ext.to_string()))
}

fn print_docx(doc: &PrintDoc, dest: &Path) -> Result<(), String> {
    let (pw, ph) = print_paper_mm(&doc.paper);
    let margin = print_margin_mm(&doc.margin);
    let content_twips = (pw - margin * 2.0) * 56.6929;
    let mut media: Vec<(String, Vec<u8>, String)> = Vec::new();
    let mut rels = String::new();
    let mut paras = String::new();
    let mut i = 0usize;
    let mut pic_id = 0;
    while i < doc.blocks.len() {
        let b = &doc.blocks[i];
        match b.kind.as_str() {
            "title" => {
                let mut author = String::new();
                if i + 1 < doc.blocks.len() && doc.blocks[i + 1].kind == "author" {
                    author = doc.blocks[i + 1].text.clone();
                    i += 1;
                }
                let run = docx_run(&b.text, doc.font_size * 2.4, true, false, &doc.font);
                paras.push_str(&docx_p(&run, "center", 0.8, 1.3, 0.0, false));
                if !author.is_empty() {
                    let arun = docx_run(&author, doc.font_size * 1.05, false, false, &doc.font);
                    paras.push_str(&docx_p(&arun, "center", 0.6, 1.2, 0.0, false));
                }
                paras.push_str(&docx_p(
                    "<w:r><w:br w:type=\"page\"/></w:r>",
                    "left",
                    0.0,
                    1.0,
                    0.0,
                    false,
                ));
            }
            "author" => {}
            "pagebreak" => paras.push_str(&docx_p(
                "<w:r><w:br w:type=\"page\"/></w:r>",
                "left",
                0.0,
                1.0,
                0.0,
                false,
            )),
            "heading" => {
                let run = docx_run(&b.text, doc.font_size * 1.45, true, false, &doc.font);
                paras.push_str(&docx_p(&run, "center", 0.9, 1.35, 0.0, b.page_break));
            }
            "kicker" => {
                let run = docx_run(&b.text, doc.font_size * 0.9, false, false, &doc.font);
                paras.push_str(&docx_p(&run, "center", 0.5, 1.2, 0.0, false));
            }
            "quote" => {
                let run = docx_run(&b.text, doc.font_size, false, true, &doc.font);
                paras.push_str(&docx_p(&run, "both", 0.4, doc.line_height, doc.font_size * 2.0, false));
            }
            "image" => {
                if let Some((bytes, ext)) = data_url_bytes(&b.src) {
                    pic_id += 1;
                    let rid = format!("rIdImg{}", pic_id);
                    let name = format!("image{}.{}", pic_id, ext);
                    let ctype = if ext == "jpg" { "jpeg" } else { ext.as_str() };
                    rels.push_str(&format!(
                        "<Relationship Id=\"{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/{}\"/>",
                        rid, name
                    ));
                    media.push((name.clone(), bytes, ctype.to_string()));
                    let mut cx = b.width * 9525.0;
                    let mut cy = b.height * 9525.0;
                    if cx <= 0.0 || cy <= 0.0 {
                        cx = content_twips * 635.0;
                        cy = cx * 0.66;
                    }
                    let max_cx = content_twips * 635.0;
                    if cx > max_cx {
                        cy *= max_cx / cx;
                        cx = max_cx;
                    }
                    paras.push_str(&format!(
                        "<w:p><w:pPr><w:jc w:val=\"center\"/><w:spacing w:before=\"120\" w:after=\"180\"/></w:pPr><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/><wp:docPr id=\"{pid}\" name=\"Picture {pid}\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" noChangeAspect=\"1\"/></wp:cNvGraphicFramePr><a:graphic xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\"><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:nvPicPr><pic:cNvPr id=\"{pid}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"{rid}\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>",
                        cx = cx as i64,
                        cy = cy as i64,
                        pid = pic_id,
                        name = name,
                        rid = rid,
                    ));
                }
            }
            _ => {
                let run = docx_run(&b.text, doc.font_size, false, false, &doc.font);
                paras.push_str(&docx_p(
                    &run,
                    "both",
                    0.2,
                    doc.line_height,
                    doc.indent * doc.font_size * 20.0,
                    false,
                ));
            }
        }
        i += 1;
    }

    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" \
         xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" \
         xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" \
         xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" \
         xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">\
         <w:body>{}\
         <w:sectPr><w:pgSz w:w=\"{}\" w:h=\"{}\"/><w:pgMar w:top=\"{}\" w:right=\"{}\" w:bottom=\"{}\" w:left=\"{}\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/><w:cols w:space=\"720\"/><w:docGrid w:linePitch=\"312\"/></w:sectPr>\
         </w:body></w:document>",
        paras,
        (pw * 56.6929) as i64,
        (ph * 56.6929) as i64,
        (margin * 56.6929) as i64,
        (margin * 56.6929) as i64,
        (margin * 56.6929) as i64,
        (margin * 56.6929) as i64,
    );

    let mut defaults = String::new();
    let mut exts = vec!["png", "jpeg", "gif", "webp"];
    for (_, _, ct) in &media {
        if ct == "jpeg" && !exts.contains(&"jpeg") {
            exts.push("jpeg");
        }
    }
    for e in exts {
        defaults.push_str(&format!(
            "<Default Extension=\"{}\" ContentType=\"image/{}\"/>",
            e,
            if e == "jpg" { "jpeg" } else { e }
        ));
    }
    let content_types = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
         <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
         <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
         {}<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
         </Types>",
        defaults
    );
    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
         </Relationships>";
    let doc_rels = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
         <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">{}</Relationships>",
        rels
    );

    let file = File::create(dest).map_err(|e| format!("创建 Word 失败：{}", e))?;
    let mut zip = ZipWriter::new(file);
    let opt = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, data) in [
        ("[Content_Types].xml", content_types.as_bytes()),
        ("_rels/.rels", root_rels.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", doc_rels.as_bytes()),
    ] {
        zip.start_file(name, opt).map_err(|e| e.to_string())?;
        zip.write_all(data).map_err(|e| e.to_string())?;
    }
    for (name, bytes, _) in &media {
        zip.start_file(format!("word/media/{}", name), opt)
            .map_err(|e| e.to_string())?;
        zip.write_all(bytes).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| format!("写入 Word 失败：{}", e))?;
    Ok(())
}

#[tauri::command]
fn print_export(doc: PrintDoc, dest: String, format: String) -> Result<String, String> {
    let target = PathBuf::from(&dest);
    if let Some(parent) = target.parent() {
        ensure_dir(parent)?;
    }
    match format.as_str() {
        "pdf" => {
            print_pdf(&doc, &target)?;
            Ok("已导出 PDF".into())
        }
        "word" => {
            print_docx(&doc, &target)?;
            Ok("已导出 Word".into())
        }
        _ => Err("不支持的打印格式".into()),
    }
}

#[tauri::command]
fn export_book(path: String, format: String, dest: String) -> Result<String, String> {    let project = PathBuf::from(&path);
    if !project.is_dir() {
        return Err("找不到这本书".into());
    }
    let target = PathBuf::from(&dest);
    if let Some(parent) = target.parent() {
        ensure_dir(parent)?;
    }
    let book = read_json_value(&project.join(BOOK_FILE));
    let title = book
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("未命名")
        .to_string();
    let author = book
        .get("author")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    match format.as_str() {
        "txt" => {
            let plain = build_markdown(&project, &title, &author, true);
            write_text(&target, &plain)?;
            Ok("已导出 TXT".into())
        }
        "md" => {
            let md = build_markdown(&project, &title, &author, false);
            write_text(&target, &md)?;
            Ok("已导出 Markdown".into())
        }
        "epub" => build_epub(&project, &target, &title, &author),
        _ => Err("不支持的导出格式".into()),
    }
}

#[tauri::command]
fn count_text(text: String) -> u64 {
    count_words(&text)
}

// ───────────────────────── 导入与背景图 ─────────────────────────

#[derive(Serialize)]
struct ImportDoc {
    name: String,
    text: String,
    format: String,
}

fn decode_plain(bytes: &[u8]) -> String {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Ok(s) = String::from_utf8(body.to_vec()) {
        return s;
    }
    let (text, _, _) = encoding_rs::GB18030.decode(body);
    text.into_owned()
}

fn decode_xml_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(pos) = rest.find('&') {
        out.push_str(&rest[..pos]);
        let tail = &rest[pos..];
        let semi = match tail.find(';') {
            Some(s) if s <= 12 => s,
            _ => {
                out.push('&');
                rest = &tail[1..];
                continue;
            }
        };
        let entity = &tail[1..semi];
        let decoded = match entity {
            "amp" => Some("&".to_string()),
            "lt" => Some("<".to_string()),
            "gt" => Some(">".to_string()),
            "quot" => Some("\"".to_string()),
            "apos" => Some("'".to_string()),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse::<u32>().ok()))
                .and_then(char::from_u32)
                .map(|c| c.to_string()),
        };
        match decoded {
            Some(v) => {
                out.push_str(&v);
                rest = &tail[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn strip_word_xml(xml: &str) -> String {
    let expanded = xml
        .replace("</w:p>", "\n\n")
        .replace("<w:br/>", "\n")
        .replace("<w:br />", "\n")
        .replace("<w:tab/>", "\t")
        .replace("<w:tab />", "\t");
    let mut out = String::with_capacity(expanded.len());
    let mut in_tag = false;
    for c in expanded.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let decoded = decode_xml_entities(&out).replace('\r', "");
    let mut cleaned = String::with_capacity(decoded.len());
    let mut blank = 0;
    for line in decoded.lines() {
        let t = line.trim_end();
        if t.trim().is_empty() {
            blank += 1;
            if blank <= 1 {
                cleaned.push('\n');
            }
        } else {
            blank = 0;
            cleaned.push_str(t);
            cleaned.push('\n');
        }
    }
    cleaned.trim().to_string()
}

fn read_docx(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("打不开 Word 文件：{e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("Word 文件结构损坏：{e}"))?;
    let mut xml = String::new();
    {
        let mut entry = zip
            .by_name("word/document.xml")
            .map_err(|_| "这不是有效的 .docx（缺少正文），旧版 .doc 请先另存为 .docx".to_string())?;
        entry
            .read_to_string(&mut xml)
            .map_err(|e| format!("读取 Word 正文失败：{e}"))?;
    }
    let text = strip_word_xml(&xml);
    if text.trim().is_empty() {
        return Err("Word 里没有可导入的文字".into());
    }
    Ok(text)
}

#[tauri::command]
fn read_import_file(path: String) -> Result<ImportDoc, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("找不到要导入的文件".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let name = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("导入稿")
        .to_string();
    let text = match ext.as_str() {
        "txt" | "md" | "markdown" => {
            let bytes = fs::read(&p).map_err(|e| format!("读取文件失败：{e}"))?;
            decode_plain(&bytes)
        }
        "docx" => read_docx(&p)?,
        "doc" => {
            return Err("旧版 .doc 暂不支持，请在 Word 里另存为 .docx 再导入".into());
        }
        _ => return Err("只支持 TXT、Markdown、DOCX".into()),
    };
    if text.trim().is_empty() {
        return Err("文件里没有可导入的文字".into());
    }
    Ok(ImportDoc {
        name,
        text: text.replace("\r\n", "\n").replace('\r', "\n"),
        format: ext,
    })
}

#[tauri::command]
fn image_data(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| format!("读取图片失败：{e}"))?;
    if meta.len() > 16 * 1024 * 1024 {
        return Err("背景图请不要超过 16 MB".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => return Err("背景图支持 PNG / JPG / WEBP / GIF / BMP".into()),
    };
    let bytes = fs::read(&p).map_err(|e| format!("读取图片失败：{e}"))?;
    Ok(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

// ───────────────────────── MCP / Git 本机工具层 ─────────────────────────

static CURRENT_PROJECT: Mutex<Option<PathBuf>> = Mutex::new(None);
static MCP_ENABLED: AtomicBool = AtomicBool::new(false);
static MCP_PORT: AtomicU16 = AtomicU16::new(18765);
static MCP_ERROR: Mutex<Option<String>> = Mutex::new(None);
static MCP_RUNTIME: Mutex<Option<McpRuntime>> = Mutex::new(None);

struct McpRuntime {
    stop: Arc<AtomicBool>,
}

struct ConfirmGate {
    id: String,
    gate: Arc<(Mutex<Option<bool>>, Condvar)>,
}

static MCP_CONFIRM: Mutex<Option<ConfirmGate>> = Mutex::new(None);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpStatus {
    enabled: bool,
    running: bool,
    port: u16,
    endpoint: String,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    installed: bool,
    version: String,
    is_repo: bool,
    branch: String,
    dirty: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    short: String,
    author: String,
    date: String,
    subject: String,
    refs: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitBranch {
    name: String,
    current: bool,
}

fn mcp_config_path() -> PathBuf {
    config_dir().join("mcp.json")
}

fn set_current_project(path: Option<PathBuf>) {
    *CURRENT_PROJECT.lock().unwrap() = path;
}

fn current_project() -> Result<PathBuf, String> {
    CURRENT_PROJECT
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "还没有打开的书。先调用 open_book，或在 Chapter 里打开一本。".to_string())
}

fn emit_change(app: &tauri::AppHandle, project: &Path, kind: &str, focus: Option<&str>) {
    let _ = app.emit(
        "mcp-data-changed",
        json!({
            "path": project.to_string_lossy(),
            "kind": kind,
            "focusChapter": focus,
        }),
    );
}

fn request_confirm(
    app: &tauri::AppHandle,
    action: &str,
    title: &str,
    message: &str,
    vars: serde_json::Value,
) -> bool {
    let id = format!("mcp_{}", now_ms());
    let gate = Arc::new((Mutex::new(None::<bool>), Condvar::new()));
    {
        let mut slot = MCP_CONFIRM.lock().unwrap();
        *slot = Some(ConfirmGate {
            id: id.clone(),
            gate: gate.clone(),
        });
    }
    let _ = app.emit(
        "mcp-confirm",
        json!({
            "id": id,
            "action": action,
            "title": title,
            "message": message,
            "vars": vars,
        }),
    );
    let (lock, cvar) = &*gate;
    let mut state = lock.lock().unwrap();
    let deadline = Instant::now() + Duration::from_secs(90);
    while state.is_none() {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            break;
        }
        let (next, timeout) = cvar.wait_timeout(state, remain).unwrap();
        state = next;
        if timeout.timed_out() {
            break;
        }
    }
    let allow = state.unwrap_or(false);
    let mut slot = MCP_CONFIRM.lock().unwrap();
    if slot.as_ref().map(|p| p.id == id).unwrap_or(false) {
        *slot = None;
    }
    allow
}

#[tauri::command]
fn mcp_confirm(id: String, allow: bool) -> Result<(), String> {
    let slot = MCP_CONFIRM.lock().unwrap();
    if let Some(pending) = slot.as_ref() {
        if pending.id == id {
            let (lock, cvar) = &*pending.gate;
            *lock.lock().unwrap() = Some(allow);
            cvar.notify_all();
        }
    }
    Ok(())
}

fn mcp_status_inner() -> McpStatus {
    let port = MCP_PORT.load(Ordering::Relaxed);
    let running = MCP_RUNTIME.lock().map(|r| r.is_some()).unwrap_or(false);
    McpStatus {
        enabled: MCP_ENABLED.load(Ordering::Relaxed),
        running,
        port,
        endpoint: format!("http://127.0.0.1:{port}/mcp"),
        error: MCP_ERROR.lock().unwrap().clone(),
    }
}

#[tauri::command]
fn mcp_status() -> McpStatus {
    mcp_status_inner()
}

fn start_mcp_server(app: tauri::AppHandle, port: u16) -> Result<(), String> {
    if port < 1024 {
        return Err("MCP 端口必须大于 1024".into());
    }
    if MCP_RUNTIME.lock().unwrap().is_some() {
        return Ok(());
    }
    let server = tiny_http::Server::http(("127.0.0.1", port))
        .map_err(|e| format!("MCP 端口 {port} 启动失败：{e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    MCP_PORT.store(port, Ordering::Relaxed);
    thread::spawn(move || {
        while !stop_thread.load(Ordering::Relaxed) {
            match server.recv_timeout(Duration::from_millis(260)) {
                Ok(Some(mut request)) => {
                    let cors = tiny_http::Header::from_bytes(
                        &b"Access-Control-Allow-Origin"[..],
                        &b"*"[..],
                    )
                    .unwrap();
                    let allow = tiny_http::Header::from_bytes(
                        &b"Access-Control-Allow-Methods"[..],
                        &b"POST, OPTIONS"[..],
                    )
                    .unwrap();
                    let allow_h = tiny_http::Header::from_bytes(
                        &b"Access-Control-Allow-Headers"[..],
                        &b"Content-Type, Accept"[..],
                    )
                    .unwrap();
                    if *request.method() == tiny_http::Method::Options {
                        let _ = request.respond(
                            tiny_http::Response::empty(204)
                                .with_header(cors)
                                .with_header(allow)
                                .with_header(allow_h),
                        );
                        continue;
                    }
                    if *request.method() != tiny_http::Method::Post {
                        let _ = request.respond(
                            tiny_http::Response::from_string("Chapter MCP 已运行")
                                .with_header(cors),
                        );
                        continue;
                    }
                    let mut body = String::new();
                    let _ = request.as_reader().read_to_string(&mut body);
                    let reply = handle_mcp_json(&body, &app);
                    let reply_has_body = reply.is_some();
                    let response = tiny_http::Response::from_string(reply.unwrap_or_default())
                        .with_status_code(tiny_http::StatusCode(if reply_has_body { 200 } else { 202 }));
                    let _ = request.respond(
                        response
                            .with_header(cors)
                            .with_header(allow)
                            .with_header(allow_h)
                            .with_header(
                                tiny_http::Header::from_bytes(
                                    &b"Content-Type"[..],
                                    &b"application/json; charset=utf-8"[..],
                                )
                                .unwrap(),
                            ),
                    );
                }
                Ok(None) => {}
                Err(_) => break,
            }
        }
    });
    *MCP_RUNTIME.lock().unwrap() = Some(McpRuntime { stop });
    *MCP_ERROR.lock().unwrap() = None;
    MCP_ENABLED.store(true, Ordering::Relaxed);
    Ok(())
}

fn stop_mcp_server() {
    if let Some(runtime) = MCP_RUNTIME.lock().unwrap().take() {
        runtime.stop.store(true, Ordering::Relaxed);
    }
    MCP_ENABLED.store(false, Ordering::Relaxed);
}

#[tauri::command]
fn mcp_set_enabled(app: tauri::AppHandle, enabled: bool, port: u16) -> Result<McpStatus, String> {
    MCP_PORT.store(port, Ordering::Relaxed);
    if enabled {
        if let Err(e) = start_mcp_server(app, port) {
            *MCP_ERROR.lock().unwrap() = Some(e);
            MCP_ENABLED.store(true, Ordering::Relaxed);
        }
    } else {
        stop_mcp_server();
        *MCP_ERROR.lock().unwrap() = None;
    }
    let cfg = json!({ "enabled": enabled, "port": port });
    let path = mcp_config_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        path,
        serde_json::to_string_pretty(&cfg).unwrap_or_default(),
    );
    Ok(mcp_status_inner())
}

#[tauri::command]
fn mcp_set_project(path: Option<String>) -> Result<(), String> {
    let next = path.and_then(|p| {
        let trimmed = p.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(PathBuf::from(trimmed))
        }
    });
    set_current_project(next);
    Ok(())
}

#[tauri::command]
fn mcp_config() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| format!("找不到 Chapter 可执行文件：{e}"))?;
    Ok(serde_json::to_string_pretty(&json!({
        "mcpServers": {
            "chapter": {
                "command": exe.to_string_lossy(),
                "args": ["--mcp-stdio"]
            }
        }
    }))
    .unwrap())
}

// ───────────────────────── Git（全部 GUI 命令） ─────────────────────────

fn quiet_git(cwd: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(cwd);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    cmd
}

fn git_installed_version() -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = quiet_git(cwd, args)
        .output()
        .map_err(|e| format!("无法运行 Git：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        if err.is_empty() {
            return Err("Git 命令失败".into());
        }
        return Err(err);
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn git_ok(cwd: &Path, args: &[&str]) -> bool {
    quiet_git(cwd, args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn git_is_repo(path: &Path) -> bool {
    path.is_dir() && path.join(".git").is_dir()
}

fn git_branch_of(path: &Path) -> String {
    run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default()
}

fn git_dirty(path: &Path) -> bool {
    run_git(path, &["status", "--porcelain"])
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

fn git_status_of(path: &Path) -> GitStatus {
    let installed = git_installed_version();
    let is_repo = git_is_repo(path);
    GitStatus {
        installed: installed.is_some(),
        version: installed.unwrap_or_default(),
        is_repo,
        branch: if is_repo { git_branch_of(path) } else { String::new() },
        dirty: if is_repo { git_dirty(path) } else { false },
    }
}

#[tauri::command]
fn git_status(path: String) -> Result<GitStatus, String> {
    let p = PathBuf::from(path.trim());
    Ok(git_status_of(&p))
}

fn sanitize_branch(name: &str) -> Result<String, String> {
    let clean = name.trim().replace(' ', "-");
    if clean.is_empty() || clean.len() > 64 {
        return Err("存档线名称需要 1–64 个字符".into());
    }
    if clean.starts_with('-')
        || clean.starts_with('.')
        || clean.contains("..")
        || !clean
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '/' | '.'))
    {
        return Err("存档线名称只能包含字母、数字、中文、短横线、下划线和斜杠".into());
    }
    Ok(clean)
}

#[tauri::command]
fn git_init(path: String) -> Result<GitStatus, String> {
    let dir = PathBuf::from(path.trim());
    if !dir.is_dir() {
        return Err("找不到这本书的工程目录".into());
    }
    if git_installed_version().is_none() {
        return Err("还没有安装 Git。请先在设置里打开官方下载页。".into());
    }
    if !git_is_repo(&dir) {
        run_git(&dir, &["init"])?;
    }
    let _ = run_git(&dir, &["config", "user.name", "Chapter"]);
    let _ = run_git(&dir, &["config", "user.email", "chapter@local"]);
    let ignore = "snapshots/\n.chapter-restore-backup/\n*.tmp\n";
    let ignore_path = dir.join(".gitignore");
    if !ignore_path.exists() {
        write_text(&ignore_path, ignore)?;
    }
    if !git_is_repo(&dir) {
        return Err("Git 仓库创建失败".into());
    }
    run_git(&dir, &["add", "-A"])?;
    let _ = quiet_git(&dir, &["commit", "--allow-empty", "-m", "开启版本管理"]).output();
    Ok(git_status_of(&dir))
}

fn git_snapshot_inner(dir: &Path, message: &str) -> Result<GitStatus, String> {
    if !git_is_repo(dir) {
        return Err("这本书还没有开启版本管理".into());
    }
    run_git(dir, &["add", "-A"])?;
    let msg = if message.trim().is_empty() {
        "手动存档"
    } else {
        message.trim()
    };
    // 即使正文没有变化，也让用户看到这次存档；写作软件的版本更像“拍快照”。
    let _ = quiet_git(dir, &["commit", "--allow-empty", "-m", msg]).output();
    Ok(git_status_of(dir))
}

#[tauri::command]
fn git_snapshot(path: String, message: String) -> Result<GitStatus, String> {
    git_snapshot_inner(&PathBuf::from(path.trim()), &message)
}

#[tauri::command]
fn git_history(path: String) -> Result<Vec<GitCommit>, String> {
    let dir = PathBuf::from(path.trim());
    if !git_is_repo(&dir) {
        return Ok(Vec::new());
    }
    let raw = run_git(
        &dir,
        &[
            "log",
            "--all",
            "-n",
            "60",
            "--date=format:%Y-%m-%d %H:%M",
            "--pretty=format:%H\x1f%h\x1f%an\x1f%ad\x1f%D\x1f%s\x1e",
        ],
    )?;
    let mut out = Vec::new();
    for record in raw.split('\u{1e}') {
        let rec = record.trim_matches(['\r', '\n']);
        if rec.is_empty() {
            continue;
        }
        let parts: Vec<&str> = rec.split('\u{1f}').collect();
        if parts.len() < 6 {
            continue;
        }
        out.push(GitCommit {
            hash: parts[0].to_string(),
            short: parts[1].to_string(),
            author: parts[2].to_string(),
            date: parts[3].to_string(),
            refs: parts[4].to_string(),
            subject: parts[5].to_string(),
        });
    }
    Ok(out)
}

#[tauri::command]
fn git_restore(path: String, hash: String) -> Result<ProjectPayload, String> {
    let dir = PathBuf::from(path.trim());
    let safe_hash = hash.trim();
    if safe_hash.len() < 7 || !safe_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("版本号格式不正确".into());
    }
    if !git_is_repo(&dir) {
        return Err("这本书还没有开启版本管理".into());
    }
    if !git_ok(&dir, &["cat-file", "-e", &format!("{safe_hash}^{{commit}}")]) {
        return Err("找不到这个版本".into());
    }
    // 先留后路，再回档。
    let _ = git_snapshot_inner(&dir, "回档前自动存档");
    run_git(&dir, &["checkout", safe_hash, "--", "."])?;
    let msg = format!("回档到 {}", &safe_hash[..safe_hash.len().min(8)]);
    let _ = quiet_git(&dir, &["add", "-A"]).output();
    let _ = quiet_git(&dir, &["commit", "--allow-empty", "-m", &msg]).output();
    load_project(&dir)
}

#[tauri::command]
fn git_branches(path: String) -> Result<Vec<GitBranch>, String> {
    let dir = PathBuf::from(path.trim());
    if !git_is_repo(&dir) {
        return Ok(Vec::new());
    }
    let raw = run_git(&dir, &["branch", "--format=%(refname:short)|%(HEAD)"])?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let mut it = line.split('|');
        let name = it.next().unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        out.push(GitBranch {
            name: name.to_string(),
            current: it.next().unwrap_or("").trim() == "*",
        });
    }
    Ok(out)
}

#[tauri::command]
fn git_create_branch(path: String, name: String) -> Result<GitStatus, String> {
    let dir = PathBuf::from(path.trim());
    if !git_is_repo(&dir) {
        return Err("这本书还没有开启版本管理".into());
    }
    let branch = sanitize_branch(&name)?;
    let _ = git_snapshot_inner(&dir, "切换存档线前自动存档");
    run_git(&dir, &["checkout", "-b", &branch])?;
    Ok(git_status_of(&dir))
}

#[tauri::command]
fn git_switch_branch(path: String, name: String) -> Result<ProjectPayload, String> {
    let dir = PathBuf::from(path.trim());
    if !git_is_repo(&dir) {
        return Err("这本书还没有开启版本管理".into());
    }
    let branch = sanitize_branch(&name)?;
    let _ = git_snapshot_inner(&dir, "切换存档线前自动存档");
    run_git(&dir, &["checkout", &branch])?;
    load_project(&dir)
}

// ───────────────────────── MCP JSON-RPC 工具 ─────────────────────────

fn mcp_tool_result(value: Value, is_error: bool) -> Value {
    let text = if is_error {
        value.as_str().unwrap_or("MCP 工具失败").to_string()
    } else {
        serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".into())
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error
    })
}

fn mcp_rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn mcp_tools() -> Value {
    json!([
        {
            "name": "chapter_status",
            "description": "查看 Chapter 是否打开、当前工程路径和 MCP 状态。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_books",
            "description": "列出本机书库里的所有小说工程。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "open_book",
            "description": "打开一本书，并让 Chapter 界面同步切过去。",
            "inputSchema": { "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] }
        },
        {
            "name": "get_book",
            "description": "读取当前书的元信息、卷章结构（不含正文）。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "create_book",
            "description": "新建一本小说，会自动生成第一卷第一章。",
            "inputSchema": { "type": "object", "properties": { "title": { "type": "string" }, "author": { "type": "string" }, "target_words": { "type": "number" }, "daily_goal": { "type": "number" } }, "required": ["title"] }
        },
        {
            "name": "update_book",
            "description": "修改书名、作者、简介、全书目标或每日目标。",
            "inputSchema": { "type": "object", "properties": { "title": { "type": "string" }, "author": { "type": "string" }, "description": { "type": "string" }, "target_words": { "type": "number" }, "daily_goal": { "type": "number" } } }
        },
        {
            "name": "create_volume",
            "description": "在当前书里新建一卷。",
            "inputSchema": { "type": "object", "properties": { "title": { "type": "string" } } }
        },
        {
            "name": "update_volume",
            "description": "重命名一卷。",
            "inputSchema": { "type": "object", "properties": { "volume_id": { "type": "string" }, "title": { "type": "string" } }, "required": ["volume_id", "title"] }
        },
        {
            "name": "create_chapter",
            "description": "新建一章，可指定卷、标题和正文。",
            "inputSchema": { "type": "object", "properties": { "volume_id": { "type": "string" }, "title": { "type": "string" }, "body": { "type": "string" } } }
        },
        {
            "name": "update_chapter",
            "description": "修改章节标题、摘要或正文。",
            "inputSchema": { "type": "object", "properties": { "chapter_id": { "type": "string" }, "title": { "type": "string" }, "summary": { "type": "string" }, "body": { "type": "string" } }, "required": ["chapter_id"] }
        },
        {
            "name": "delete_chapter",
            "description": "删除一章。必须在 Chapter 界面由用户点「允许」后才会执行。",
            "inputSchema": { "type": "object", "properties": { "chapter_id": { "type": "string" } }, "required": ["chapter_id"] }
        },
        {
            "name": "delete_volume",
            "description": "删除一卷。必须在 Chapter 界面由用户点「允许」后才会执行。",
            "inputSchema": { "type": "object", "properties": { "volume_id": { "type": "string" } }, "required": ["volume_id"] }
        },
        {
            "name": "delete_book",
            "description": "把当前整本书移到书库回收站。必须在 Chapter 界面由用户点「允许」后才会执行。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "update_outline",
            "description": "修改整书大纲（Markdown），同时写入 outline.md。",
            "inputSchema": { "type": "object", "properties": { "markdown": { "type": "string" } }, "required": ["markdown"] }
        },
        {
            "name": "set_cover",
            "description": "用本机图片替换当前书封面。",
            "inputSchema": { "type": "object", "properties": { "source_path": { "type": "string" } }, "required": ["source_path"] }
        },
        {
            "name": "write_markdown",
            "description": "在当前工程 notes/ 目录写一个 Markdown 文件。",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string" }, "content": { "type": "string" } }, "required": ["name", "content"] }
        },
        {
            "name": "git_init",
            "description": "为当前书开启版本管理（本地 Git）。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "git_snapshot",
            "description": "给当前书存一个 Git 版本。",
            "inputSchema": { "type": "object", "properties": { "message": { "type": "string" } } }
        },
        {
            "name": "git_history",
            "description": "列出当前书的最近版本。",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "git_restore",
            "description": "回到某个版本。必须先由用户在 Chapter 界面确认。",
            "inputSchema": { "type": "object", "properties": { "hash": { "type": "string" } }, "required": ["hash"] }
        },
        {
            "name": "git_create_branch",
            "description": "新建一条版本存档线（不是剧情分支）。",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }
        },
        {
            "name": "git_switch_branch",
            "description": "切换到另一条版本存档线。",
            "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }
        }
    ])
}

fn mcp_outline_public(project: &Path) -> Value {
    let outline = read_json_value(&project.join(OUTLINE_FILE));
    let mut vols = Vec::new();
    if let Some(list) = outline.get("volumes").and_then(|v| v.as_array()) {
        for v in list {
            let chapters = v
                .get("chapters")
                .and_then(|c| c.as_array())
                .map(|cs| {
                    cs.iter()
                        .map(|c| {
                            json!({
                                "id": c.get("id").and_then(|x| x.as_str()),
                                "title": c.get("title").and_then(|x| x.as_str()),
                                "summary": c.get("summary").and_then(|x| x.as_str()).unwrap_or(""),
                                "words": c.get("words").and_then(|x| x.as_u64()).unwrap_or(0)
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            vols.push(json!({
                "id": v.get("id").and_then(|x| x.as_str()),
                "title": v.get("title").and_then(|x| x.as_str()),
                "chapters": chapters
            }));
        }
    }
    let book = read_json_value(&project.join(BOOK_FILE));
    json!({
        "path": project.to_string_lossy(),
        "book": book,
        "volumes": vols
    })
}

fn touch_book(project: &Path) {
    let mut book = read_json_value(&project.join(BOOK_FILE));
    if book.is_null() {
        book = json!({});
    }
    book["updatedAt"] = json!(now_ms());
    let _ = write_json(
        &project.join(BOOK_FILE),
        &serde_json::to_string(&book).unwrap_or_default(),
    );
}

fn mcp_exec(app: &tauri::AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "chapter_status" => Ok(json!({
            "mcp": mcp_status_inner(),
            "project": CURRENT_PROJECT.lock().unwrap().as_ref().map(|p| p.to_string_lossy().to_string())
        })),

        "list_books" => Ok(serde_json::to_value(list_books()?).unwrap_or(json!([]))),

        "open_book" => {
            let path = args.get("path").and_then(|v| v.as_str()).ok_or("缺少 path")?;
            let payload = open_book(path.to_string())?;
            set_current_project(Some(PathBuf::from(path)));
            let _ = app.emit("mcp-open-book", json!({ "path": path }));
            let book = read_json_value(&PathBuf::from(path).join(BOOK_FILE));
            Ok(json!({ "path": payload.path, "book": book }))
        }

        "get_book" => {
            let p = current_project()?;
            Ok(mcp_outline_public(&p))
        }

        "create_book" => {
            let title = args.get("title").and_then(|v| v.as_str()).ok_or("缺少 title")?;
            let author = args.get("author").and_then(|v| v.as_str()).unwrap_or("");
            let target = args.get("target_words").and_then(|v| v.as_u64()).unwrap_or(200000);
            let goal = args.get("daily_goal").and_then(|v| v.as_u64()).unwrap_or(2000);
            let payload = create_book(title.to_string(), author.to_string(), target, goal)?;
            set_current_project(Some(PathBuf::from(&payload.path)));
            let _ = app.emit("mcp-open-book", json!({ "path": payload.path }));
            let book = read_json_value(&PathBuf::from(&payload.path).join(BOOK_FILE));
            Ok(json!({ "path": payload.path, "book": book }))
        }

        "update_book" => {
            let p = current_project()?;
            let mut book = read_json_value(&p.join(BOOK_FILE));
            if book.is_null() {
                book = json!({});
            }
            if let Some(v) = args.get("title").and_then(|x| x.as_str()) { book["title"] = json!(v.trim()); }
            if let Some(v) = args.get("author").and_then(|x| x.as_str()) { book["author"] = json!(v.trim()); }
            if let Some(v) = args.get("description").and_then(|x| x.as_str()) { book["description"] = json!(v); }
            if let Some(v) = args.get("target_words").and_then(|x| x.as_u64()) { book["targetWords"] = json!(v); }
            if let Some(v) = args.get("daily_goal").and_then(|x| x.as_u64()) { book["dailyGoal"] = json!(v); }
            book["updatedAt"] = json!(now_ms());
            write_json(&p.join(BOOK_FILE), &serde_json::to_string(&book).unwrap())?;
            emit_change(app, &p, "book", None);
            Ok(book)
        }

        "create_volume" => {
            let p = current_project()?;
            let mut outline = read_json_value(&p.join(OUTLINE_FILE));
            let vols = outline
                .get_mut("volumes")
                .and_then(|v| v.as_array_mut())
                .ok_or("大纲文件里没有 volumes 数组")?;
            let id = format!("v_{}", now_ms());
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| format!("第{}卷", vols.len() + 1));
            vols.push(json!({ "id": id, "title": title, "collapsed": false, "chapters": [] }));
            write_json(&p.join(OUTLINE_FILE), &serde_json::to_string(&outline).unwrap())?;
            touch_book(&p);
            emit_change(app, &p, "outline", None);
            Ok(json!({ "id": id, "title": title }))
        }

        "update_volume" => {
            let p = current_project()?;
            let vid = args.get("volume_id").and_then(|v| v.as_str()).ok_or("缺少 volume_id")?;
            let title = args.get("title").and_then(|v| v.as_str()).map(|s| s.trim()).filter(|s| !s.is_empty()).ok_or("缺少 title")?;
            let mut outline = read_json_value(&p.join(OUTLINE_FILE));
            let mut found = false;
            if let Some(vols) = outline.get_mut("volumes").and_then(|v| v.as_array_mut()) {
                if let Some(v) = vols.iter_mut().find(|v| v.get("id").and_then(|x| x.as_str()) == Some(vid)) {
                    v["title"] = json!(title);
                    found = true;
                }
            }
            if !found { return Err("找不到指定的卷".into()); }
            write_json(&p.join(OUTLINE_FILE), &serde_json::to_string(&outline).unwrap())?;
            touch_book(&p);
            emit_change(app, &p, "outline", None);
            Ok(json!({ "id": vid, "title": title }))
        }

        "create_chapter" => {
            let p = current_project()?;
            let mut outline = read_json_value(&p.join(OUTLINE_FILE));
            let vols = outline
                .get_mut("volumes")
                .and_then(|v| v.as_array_mut())
                .ok_or("大纲文件里没有 volumes 数组")?;
            if vols.is_empty() {
                let vid = format!("v_{}", now_ms());
                vols.push(json!({ "id": vid, "title": "第一卷", "collapsed": false, "chapters": [] }));
            }
            let wanted = args.get("volume_id").and_then(|v| v.as_str());
            let vi = if let Some(wid) = wanted {
                vols.iter()
                    .position(|v| v.get("id").and_then(|x| x.as_str()) == Some(wid))
                    .ok_or("找不到指定的卷")?
            } else {
                0
            };
            let chapters = vols[vi]
                .get_mut("chapters")
                .and_then(|v| v.as_array_mut())
                .ok_or("这一卷没有 chapters 数组")?;
            let id = format!("c_{}", now_ms());
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| format!("第{}章", chapters.len() + 1));
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let words = count_words(body);
            chapters.push(json!({
                "id": id,
                "title": title,
                "summary": "",
                "scenes": [],
                "words": words,
                "updatedAt": now_ms()
            }));
            write_json(&p.join(OUTLINE_FILE), &serde_json::to_string(&outline).unwrap())?;
            write_chapter_body(&chapters_dir(&p).join(format!("{id}.md")), &id, &title, body)?;
            touch_book(&p);
            emit_change(app, &p, "chapter", Some(&id));
            Ok(json!({ "id": id, "title": title, "words": words }))
        }

        "update_chapter" => {
            let p = current_project()?;
            let cid = args.get("chapter_id").and_then(|v| v.as_str()).ok_or("缺少 chapter_id")?;
            let mut outline = read_json_value(&p.join(OUTLINE_FILE));
            let mut title_now = String::new();
            {
                let vols = outline.get_mut("volumes").and_then(|v| v.as_array_mut()).ok_or("大纲损坏")?;
                let mut found = false;
                for v in vols.iter_mut() {
                    if let Some(cs) = v.get_mut("chapters").and_then(|c| c.as_array_mut()) {
                        if let Some(ch) = cs.iter_mut().find(|c| c.get("id").and_then(|x| x.as_str()) == Some(cid)) {
                            if let Some(t) = args.get("title").and_then(|x| x.as_str()) {
                                if !t.trim().is_empty() { ch["title"] = json!(t.trim()); }
                            }
                            if let Some(s) = args.get("summary").and_then(|x| x.as_str()) {
                                ch["summary"] = json!(s);
                            }
                            if let Some(b) = args.get("body").and_then(|x| x.as_str()) {
                                ch["words"] = json!(count_words(b));
                            }
                            ch["updatedAt"] = json!(now_ms());
                            title_now = ch.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
                            found = true;
                            break;
                        }
                    }
                }
                if !found { return Err("找不到这一章".into()); }
            }
            if let Some(body) = args.get("body").and_then(|x| x.as_str()) {
                write_chapter_body(&chapters_dir(&p).join(format!("{cid}.md")), cid, &title_now, body)?;
            }
            write_json(&p.join(OUTLINE_FILE), &serde_json::to_string(&outline).unwrap())?;
            touch_book(&p);
            emit_change(app, &p, "chapter", Some(cid));
            Ok(json!({ "id": cid, "title": title_now }))
        }

        "delete_chapter" => {
            let p = current_project()?;
            let cid = args.get("chapter_id").and_then(|v| v.as_str()).ok_or("缺少 chapter_id")?;
            let outline = read_json_value(&p.join(OUTLINE_FILE));
            let mut title = String::new();
            let mut volume = String::new();
            if let Some(vols) = outline.get("volumes").and_then(|v| v.as_array()) {
                for v in vols {
                    if let Some(cs) = v.get("chapters").and_then(|c| c.as_array()) {
                        if let Some(ch) = cs.iter().find(|c| c.get("id").and_then(|x| x.as_str()) == Some(cid)) {
                            title = ch.get("title").and_then(|x| x.as_str()).unwrap_or("这一章").to_string();
                            volume = v.get("title").and_then(|x| x.as_str()).unwrap_or("").to_string();
                            break;
                        }
                    }
                }
            }
            if title.is_empty() {
                return Err("找不到这一章".into());
            }
            let message = "《{title}》将从「{volume}」删除；正文文件会改名成 .md.deleted 留在工程目录。";
            if !request_confirm(
                app,
                "delete_chapter",
                "AI 请求删除一章",
                message,
                json!({ "title": title, "volume": volume }),
            ) {
                return Ok(json!({ "status": "denied" }));
            }
            let mut outline = read_json_value(&p.join(OUTLINE_FILE));
            if let Some(vols) = outline.get_mut("volumes").and_then(|v| v.as_array_mut()) {
                for v in vols.iter_mut() {
                    if let Some(cs) = v.get_mut("chapters").and_then(|c| c.as_array_mut()) {
                        if let Some(pos) = cs.iter().position(|c| c.get("id").and_then(|x| x.as_str()) == Some(cid)) {
                            cs.remove(pos);
                            break;
                        }
                    }
                }
            }
            write_json(&p.join(OUTLINE_FILE), &serde_json::to_string(&outline).unwrap())?;
            let file = chapters_dir(&p).join(format!("{cid}.md"));
            if file.exists() {
                let _ = fs::rename(&file, chapters_dir(&p).join(format!("{cid}.md.deleted")));
            }
            touch_book(&p);
            emit_change(app, &p, "outline", None);
            Ok(json!({ "status": "deleted", "title": title }))
        }

        "delete_volume" => {
            let p = current_project()?;
            let vid = args.get("volume_id").and_then(|v| v.as_str()).ok_or("缺少 volume_id")?;
            let outline = read_json_value(&p.join(OUTLINE_FILE));
            let mut title = String::new();
            let mut count = 0usize;
            if let Some(vols) = outline.get("volumes").and_then(|v| v.as_array()) {
                if let Some(v) = vols.iter().find(|v| v.get("id").and_then(|x| x.as_str()) == Some(vid)) {
                    title = v.get("title").and_then(|x| x.as_str()).unwrap_or("这一卷").to_string();
                    count = v.get("chapters").and_then(|c| c.as_array()).map(|a| a.len()).unwrap_or(0);
                }
            }
            if title.is_empty() {
                return Err("找不到这一卷".into());
            }
            let message = "《{title}》和它下面的 {count} 章会从目录移除；正文文件仍留在工程目录。";
            if !request_confirm(
                app,
                "delete_volume",
                "AI 请求删除一卷",
                message,
                json!({ "title": title, "count": count }),
            ) {
                return Ok(json!({ "status": "denied" }));
            }
            let mut outline = read_json_value(&p.join(OUTLINE_FILE));
            if let Some(vols) = outline.get_mut("volumes").and_then(|v| v.as_array_mut()) {
                if let Some(pos) = vols.iter().position(|v| v.get("id").and_then(|x| x.as_str()) == Some(vid)) {
                    vols.remove(pos);
                }
            }
            write_json(&p.join(OUTLINE_FILE), &serde_json::to_string(&outline).unwrap())?;
            touch_book(&p);
            emit_change(app, &p, "outline", None);
            Ok(json!({ "status": "deleted", "title": title }))
        }

        "delete_book" => {
            let p = current_project()?;
            let book = read_json_value(&p.join(BOOK_FILE));
            let title = book
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("这本书")
                .to_string();
            if !request_confirm(
                app,
                "delete_book",
                "AI 请求删除这本书",
                "整本工程会移到书库的 .回收站，不会立刻销毁。",
                json!({ "title": title }),
            ) {
                return Ok(json!({ "status": "denied" }));
            }
            delete_book(p.to_string_lossy().to_string())?;
            *CURRENT_PROJECT.lock().unwrap() = None;
            let _ = app.emit("mcp-book-deleted", json!({ "path": p.to_string_lossy() }));
            Ok(json!({ "status": "trashed", "title": title }))
        }

        "update_outline" => {
            let p = current_project()?;
            let md = args.get("markdown").and_then(|v| v.as_str()).ok_or("缺少 markdown")?;
            let mut book = read_json_value(&p.join(BOOK_FILE));
            book["bookOutline"] = json!(md);
            book["updatedAt"] = json!(now_ms());
            write_json(&p.join(BOOK_FILE), &serde_json::to_string(&book).unwrap())?;
            write_text(&p.join("outline.md"), md)?;
            emit_change(app, &p, "book", None);
            Ok(json!({ "status": "saved", "path": p.join("outline.md").to_string_lossy() }))
        }

        "set_cover" => {
            let p = current_project()?;
            let src = args.get("source_path").and_then(|v| v.as_str()).ok_or("缺少 source_path")?;
            let rel = set_cover(p.to_string_lossy().to_string(), src.to_string())?;
            emit_change(app, &p, "cover", None);
            Ok(json!({ "cover": rel }))
        }

        "write_markdown" => {
            let p = current_project()?;
            let name = args.get("name").and_then(|v| v.as_str()).ok_or("缺少 name")?;
            let content = args.get("content").and_then(|v| v.as_str()).ok_or("缺少 content")?;
            let mut file = sanitize_name(name);
            if !file.ends_with(".md") {
                file.push_str(".md");
            }
            let dir = p.join("notes");
            ensure_dir(&dir)?;
            let dest = dir.join(file);
            write_text(&dest, content)?;
            Ok(json!({ "path": dest.to_string_lossy() }))
        }

        "git_init" => {
            let p = current_project()?;
            Ok(serde_json::to_value(git_init(p.to_string_lossy().to_string())?).unwrap())
        }
        "git_snapshot" => {
            let p = current_project()?;
            let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
            Ok(serde_json::to_value(git_snapshot(p.to_string_lossy().to_string(), message.to_string())?).unwrap())
        }
        "git_history" => {
            let p = current_project()?;
            Ok(serde_json::to_value(git_history(p.to_string_lossy().to_string())?).unwrap())
        }
        "git_restore" => {
            let p = current_project()?;
            let hash = args.get("hash").and_then(|v| v.as_str()).ok_or("缺少 hash")?;
            if !request_confirm(
                app,
                "git_restore",
                "AI 请求回档",
                "会把当前工程回到旧版本；回档前会自动存一版。",
                json!({}),
            ) {
                return Ok(json!({ "status": "denied" }));
            }
            let _ = git_restore(p.to_string_lossy().to_string(), hash.to_string())?;
            emit_change(app, &p, "git", None);
            let book = read_json_value(&p.join(BOOK_FILE));
            Ok(json!({ "status": "restored", "book": book }))
        }
        "git_create_branch" => {
            let p = current_project()?;
            let name = args.get("name").and_then(|v| v.as_str()).ok_or("缺少 name")?;
            Ok(serde_json::to_value(git_create_branch(p.to_string_lossy().to_string(), name.to_string())?).unwrap())
        }
        "git_switch_branch" => {
            let p = current_project()?;
            let name = args.get("name").and_then(|v| v.as_str()).ok_or("缺少 name")?;
            let _ = git_switch_branch(p.to_string_lossy().to_string(), name.to_string())?;
            emit_change(app, &p, "git", None);
            let book = read_json_value(&p.join(BOOK_FILE));
            Ok(json!({ "status": "switched", "book": book }))
        }

        other => Err(format!("未知工具：{other}")),
    }
}

fn handle_mcp_json(body: &str, app: &tauri::AppHandle) -> Option<String> {
    let req: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return Some(serde_json::to_string(&mcp_rpc_error(Value::Null, -32700, &format!("JSON 解析失败：{e}"))).unwrap()),
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_null() && method.starts_with("notifications/") {
        return None;
    }
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": "2025-03-26",
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "chapter", "version": "1.3.1" }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": mcp_tools() })),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(json!({}));
            let name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match mcp_exec(app, name, &args) {
                Ok(v) => Ok(mcp_tool_result(v, false)),
                Err(e) => Ok(mcp_tool_result(Value::String(e), true)),
            }
        }
        _ => Err((-32601, "未知 MCP 方法")),
    };
    match result {
        Ok(v) => Some(serde_json::to_string(&json!({ "jsonrpc": "2.0", "id": id, "result": v })).unwrap()),
        Err((code, msg)) => Some(serde_json::to_string(&mcp_rpc_error(id, code, msg)).unwrap()),
    }
}

fn post_mcp_stdio(body: &str, port: u16) -> Result<String, String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("连接 Chapter MCP 失败：{e}"))?;
    let req = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("发送 MCP 请求失败：{e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("读取 MCP 响应失败：{e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let body = text
        .split("\r\n\r\n")
        .nth(1)
        .or_else(|| text.split("\n\n").nth(1))
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(body)
}

/// 供 `chapter.exe --mcp-stdio` 使用：把 stdio 上的 MCP JSON-RPC 转发给已打开的 Chapter。
pub fn run_mcp_stdio() {
    let port = std::env::var("CHAPTER_MCP_PORT")
        .ok()
        .and_then(|v| v.parse::<u16>().ok())
        .unwrap_or(18765);
    let stdin = std::io::stdin();
    for line in BufReader::new(stdin.lock()).lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match post_mcp_stdio(line, port) {
            Ok(reply) if !reply.is_empty() => {
                println!("{reply}");
                let _ = std::io::stdout().flush();
            }
            Ok(_) => {}
            Err(e) => {
                let id = serde_json::from_str::<Value>(line)
                    .ok()
                    .and_then(|v| v.get("id").cloned())
                    .unwrap_or(Value::Null);
                println!(
                    "{}",
                    serde_json::to_string(&mcp_rpc_error(id, -32000, &e)).unwrap()
                );
                let _ = std::io::stdout().flush();
            }
        }
    }
}



#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            use tauri::Manager;
            // WebView2 在拖拽放大时会先露出宿主底色；和界面纸色对齐，避免黑边闪一下。
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(tauri::window::Color(250, 245, 236, 255)));
            }
            // 上次开着 MCP 就自动恢复，避免用户重启 Chapter 后 AI 连不上。
            if let Ok(raw) = fs::read_to_string(mcp_config_path()) {
                if let Ok(v) = serde_json::from_str::<Value>(&raw) {
                    if v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false) {
                        let port = v.get("port").and_then(|x| x.as_u64()).unwrap_or(18765) as u16;
                        let _ = start_mcp_server(app.handle().clone(), port);
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            set_library,
            list_books,
            create_book,
            open_book,
            save_json,
            save_chapter,
            read_chapter,
            delete_chapter,
            delete_book,
            set_cover,
            set_cover_image,
            cover_data,
            create_snapshot,
            list_snapshots,
            restore_snapshot,
            export_book,
            print_export,
            count_text,
            read_import_file,
            image_data,
            mcp_status,
            mcp_set_enabled,
            mcp_set_project,
            mcp_confirm,
            mcp_config,
            git_status,
            git_init,
            git_snapshot,
            git_history,
            git_restore,
            git_branches,
            git_create_branch,
            git_switch_branch
        ])
        .run(tauri::generate_context!())
        .expect("Chapter 启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_chinese_and_latin() {
        assert_eq!(count_words("你好，世界"), 4);
        assert_eq!(count_words("Hello world"), 2);
        assert_eq!(count_words("2026 年 11 月"), 4);
        assert_eq!(count_words("，。！？"), 0);
    }

    #[test]
    fn front_matter_round_trip() {
        let (head, body) = split_front_matter("---\nid: c_1\ntitle: 第一章\n---\n\n正文\n\n---\n尾");
        assert!(head.contains("id: c_1"));
        assert_eq!(body.trim(), "正文\n\n---\n尾");
    }

    #[test]
    fn inline_markdown() {
        assert_eq!(md_inline("他**走了**，*很轻*"), "他<strong>走了</strong>，<em>很轻</em>");
        assert_eq!(md_inline("a < b & c"), "a &lt; b &amp; c");
    }

    #[test]
    fn epub_contains_required_entries() {
        let dir = std::env::temp_dir().join(format!("chapter_epub_test_{}", now_ms()));
        let chapters = dir.join("chapters");
        fs::create_dir_all(&chapters).unwrap();
        fs::write(
            dir.join("book.json"),
            r##"{"id":"b_test","title":"测试书","author":"小方","frontMatter":"# 前言\n\n写在前面。","backMatter":"# 后记\n\n写在后面。"}"##,
        )
        .unwrap();
        fs::write(
            dir.join("outline.json"),
            r#"{"volumes":[{"title":"第一卷","chapters":[{"id":"c1","title":"第一章"}]}]}"#,
        )
        .unwrap();
        fs::write(chapters.join("c1.md"), "第一段。\n\n**第二段**。\n> 引用一句\n").unwrap();
        let out = dir.join("out.epub");
        build_epub(&dir, &out, "测试书", "小方").unwrap();

        let file = File::open(&out).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        for name in [
            "mimetype",
            "OEBPS/content.opf",
            "OEBPS/nav.xhtml",
            "OEBPS/title.xhtml",
            "OEBPS/chap_001.xhtml",
            "OEBPS/front.xhtml",
            "OEBPS/back.xhtml",
        ] {
            assert!(archive.by_name(name).is_ok(), "EPUB 缺少 {name}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn txt_export_has_no_markdown_tokens() {
        let dir = std::env::temp_dir().join(format!("chapter_txt_test_{}", now_ms()));
        fs::create_dir_all(dir.join("chapters")).unwrap();
        fs::write(
            dir.join("book.json"),
            r####"{"title":"测试书","author":"小方","frontMatter":"# 前言\n\n写在前面。","backMatter":"## 后记\n\n写在后面。"}"####,
        )
        .unwrap();
        fs::write(
            dir.join("outline.json"),
            r#"{"volumes":[{"title":"第一卷","chapters":[{"id":"c1","title":"第一章"}]}]}"#,
        )
        .unwrap();
        fs::write(dir.join("chapters/c1.md"), "**粗体**和[链接](https://a.b)\n\n> 引用\n").unwrap();
        let plain = build_markdown(&dir, "测试书", "小方", true);
        assert!(!plain.contains('#'));
        assert!(!plain.contains("**"));
        assert!(!plain.contains("]("));
        assert!(plain.starts_with("测试书\n\n作者：小方"));
        let md = build_markdown(&dir, "测试书", "小方", false);
        assert!(md.contains("# 测试书"));
        assert!(md.contains("### 第一章"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn print_outputs_are_valid_files() {
        let dir = std::env::temp_dir().join(format!("chapter_print_test_{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let doc = PrintDoc {
            paper: "A4".into(),
            margin: "normal".into(),
            font: "serif".into(),
            font_size: 11.0,
            line_height: 1.75,
            indent: 2.0,
            chapter_break: true,
            include_matter: true,
            title: "测试书".into(),
            author: "小方".into(),
            blocks: vec![
                PrintBlock { kind: "title".into(), text: "测试书".into(), src: String::new(), width: 0.0, height: 0.0, page_break: false },
                PrintBlock { kind: "author".into(), text: "小方".into(), src: String::new(), width: 0.0, height: 0.0, page_break: false },
                PrintBlock { kind: "pagebreak".into(), text: String::new(), src: String::new(), width: 0.0, height: 0.0, page_break: false },
                PrintBlock { kind: "heading".into(), text: "第一章".into(), src: String::new(), width: 0.0, height: 0.0, page_break: false },
                PrintBlock { kind: "p".into(), text: "这是一段正文。".into(), src: String::new(), width: 0.0, height: 0.0, page_break: false },
                PrintBlock { kind: "image".into(), text: String::new(), src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==".into(), width: 1.0, height: 1.0, page_break: false },
            ],
        };
        let docx = dir.join("out.docx");
        print_docx(&doc, &docx).unwrap();
        let file = File::open(&docx).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut xml = String::new();
        archive.by_name("word/document.xml").unwrap().read_to_string(&mut xml).unwrap();
        assert!(xml.contains("第一章"));
        assert!(xml.contains("word/media") || xml.contains("rIdImg1"));
        assert!(archive.by_name("word/media/image1.png").is_ok());
        if edge_binary().is_some() {
            let pdf = dir.join("out.pdf");
            print_pdf(&doc, &pdf).unwrap();
            assert!(fs::metadata(&pdf).unwrap().len() > 10_000);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
