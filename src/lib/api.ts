import { invoke } from "@tauri-apps/api/core";
import type {
  BookSummary,
  GitBranch,
  GitCommit,
  GitStatus,
  ImportDoc,
  McpStatus,
  RawProject,
  SeriesCharacter,
  SeriesMeta,
  SnapshotInfo,
  TransferSnapshot,
} from "../types";
import type { ComicPagePayload } from "../comic/types";

export const api = {
  library: () => invoke<string>("get_library"),
  setLibrary: (dir: string) => invoke<string>("set_library", { dir }),
  listBooks: () => invoke<BookSummary[]>("list_books"),
  listSeries: () => invoke<SeriesMeta[]>("list_series"),
  createSeries: (name: string, description?: string) =>
    invoke<SeriesMeta>("create_series", { name, description: description ?? "" }),
  updateSeries: (id: string, name: string, description?: string) =>
    invoke<SeriesMeta>("update_series", { id, name, description: description ?? "" }),
  deleteSeries: (id: string) => invoke<void>("delete_series", { id }),
  assignBookSeries: (path: string, seriesId: string | null) =>
    invoke<unknown>("assign_book_series", { path, seriesId }),
  seriesCharacters: (seriesId: string) =>
    invoke<SeriesCharacter[]>("series_characters", { seriesId }),
  setSeriesShared: (seriesId: string, bookId: string, entryId: string, shared: boolean) =>
    invoke<void>("set_series_shared", { seriesId, bookId, entryId, shared }),
  createBook: (
    title: string,
    author: string,
    target: number,
    goal: number,
    kind: "novel" | "comic" = "novel",
    seriesId?: string,
  ) =>
    invoke<RawProject>("create_book", {
      title,
      author,
      target,
      goal,
      kind,
      seriesId: seriesId ?? null,
    }),
  openBook: (path: string) => invoke<RawProject>("open_book", { path }),
  comicProject: (path: string) => invoke<string>("comic_project", { path }),
  comicSaveProject: (path: string, json: string) =>
    invoke<void>("comic_save_project", { path, json }),
  comicReadPage: (path: string, pageId: string) =>
    invoke<ComicPagePayload>("comic_read_page", { path, pageId }),
  comicSavePage: (
    path: string,
    pageId: string,
    json: string,
    layers: { id: string; dataUrl: string }[],
  ) => invoke<void>("comic_save_page", { path, pageId, json, layers }),
  comicSaveAsset: (path: string, pageId: string, name: string, dataUrl: string) =>
    invoke<string>("comic_save_asset", { path, pageId, name, dataUrl }),
  comicSaveThumbnail: (path: string, pageId: string, dataUrl: string) =>
    invoke<void>("comic_save_thumbnail", { path, pageId, dataUrl }),
  comicExportBegin: () => invoke<string>("comic_export_begin"),
  comicExportAddPage: (tempDir: string, name: string, dataUrl: string) =>
    invoke<void>("comic_export_add_page", { tempDir, name, dataUrl }),
  comicExportFinish: (tempDir: string, dest: string) =>
    invoke<number>("comic_export_finish", { tempDir, dest }),
  comicExportDiscard: (tempDir: string) =>
    invoke<void>("comic_export_discard", { tempDir }),
  comicExportSingle: (dest: string, name: string, dataUrl: string) =>
    invoke<string>("comic_export_single", { dest, name, dataUrl }),
  comicExportToApp: (name: string, dataUrl?: string, tempDir?: string) =>
    invoke<string>("comic_export_to_app", { name, dataUrl, tempDir }),
  comicNewPage: (path: string, title: string, chapterId?: string) =>
    invoke<ComicPagePayload>("comic_new_page", { path, title, chapterId }),
  comicDeletePage: (path: string, pageId: string) =>
    invoke<void>("comic_delete_page", { path, pageId }),
  saveJson: (path: string, file: string, json: string) =>
    invoke<void>("save_json", { path, file, json }),
  saveChapter: (path: string, chapter: string, title: string, body: string) =>
    invoke<number>("save_chapter", { path, chapter, title, body }),
  deleteChapter: (path: string, chapter: string) =>
    invoke<void>("delete_chapter", { path, chapter }),
  restoreChapter: (path: string, chapter: string) =>
    invoke<boolean>("restore_chapter", { path, chapter }),
  deleteBook: (path: string) => invoke<void>("delete_book", { path }),
  setCover: (path: string, source: string) =>
    invoke<string>("set_cover", { path, source }),
  setCoverImage: (path: string, dataUrl: string) =>
    invoke<string>("set_cover_image", { path, dataUrl }),
  coverData: (path: string, rel: string) =>
    invoke<string | null>("cover_data", { path, rel }),
  createSnapshot: (path: string, label: string) =>
    invoke<SnapshotInfo[]>("create_snapshot", { path, label }),
  listSnapshots: (path: string) => invoke<SnapshotInfo[]>("list_snapshots", { path }),
  restoreSnapshot: (path: string, name: string) =>
    invoke<RawProject>("restore_snapshot", { path, name }),
  exportBook: (path: string, format: string, dest: string) =>
    invoke<string>("export_book", { path, format, dest }),
  exportBookToApp: (path: string, format: string, fileName: string) =>
    invoke<string>("export_book_to_app", { path, format, fileName }),
  printExport: (doc: unknown, dest: string, format: "pdf" | "word") =>
    invoke<string>("print_export", { doc, dest, format }),
  countText: (text: string) => invoke<number>("count_text", { text }),
  readImportFile: (path: string) => invoke<ImportDoc>("read_import_file", { path }),
  readImportBytes: (name: string, format: string, data: string) =>
    invoke<ImportDoc>("read_import_bytes", { name, format, data }),
  imageData: (path: string) => invoke<string>("image_data", { path }),
  fontData: (path: string) => invoke<string>("font_data", { path }),
  mcpStatus: () => invoke<McpStatus>("mcp_status"),
  mcpSetEnabled: (enabled: boolean, port: number) =>
    invoke<McpStatus>("mcp_set_enabled", { enabled, port }),
  mcpSetProject: (path: string | null) =>
    invoke<void>("mcp_set_project", { path }),
  mcpConfirm: (id: string, allow: boolean) =>
    invoke<void>("mcp_confirm", { id, allow }),
  mcpConfig: () => invoke<string>("mcp_config"),
  gitStatus: (path: string) => invoke<GitStatus>("git_status", { path }),
  gitInit: (path: string) => invoke<GitStatus>("git_init", { path }),
  gitSnapshot: (path: string, message: string) =>
    invoke<GitStatus>("git_snapshot", { path, message }),
  gitHistory: (path: string) => invoke<GitCommit[]>("git_history", { path }),
  gitRestore: (path: string, hash: string) =>
    invoke<RawProject>("git_restore", { path, hash }),
  gitBranches: (path: string) => invoke<GitBranch[]>("git_branches", { path }),
  gitCreateBranch: (path: string, name: string) =>
    invoke<GitStatus>("git_create_branch", { path, name }),
  gitSwitchBranch: (path: string, name: string) =>
    invoke<RawProject>("git_switch_branch", { path, name }),
  transferStart: (bookPath: string | null) =>
    invoke<TransferSnapshot>("transfer_start", { bookPath }),
  transferStatus: () => invoke<TransferSnapshot>("transfer_status"),
  transferDirection: (direction: "pc_to_phone" | "phone_to_pc") =>
    invoke<TransferSnapshot>("transfer_direction", { direction }),
  transferConfirm: () => invoke<TransferSnapshot>("transfer_confirm"),
  transferCancel: () => invoke<TransferSnapshot>("transfer_cancel"),
  transferClose: () => invoke<void>("transfer_close"),
  importChapterpack: (data: string) =>
    invoke<string>("import_chapterpack", { data }),
};

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return "操作失败";
  }
}
