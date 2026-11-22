import { invoke } from "@tauri-apps/api/core";
import type {
  BookSummary,
  GitBranch,
  GitCommit,
  GitStatus,
  ImportDoc,
  McpStatus,
  RawProject,
  SnapshotInfo,
} from "../types";

export const api = {
  library: () => invoke<string>("get_library"),
  setLibrary: (dir: string) => invoke<string>("set_library", { dir }),
  listBooks: () => invoke<BookSummary[]>("list_books"),
  createBook: (title: string, author: string, target: number, goal: number) =>
    invoke<RawProject>("create_book", { title, author, target, goal }),
  openBook: (path: string) => invoke<RawProject>("open_book", { path }),
  saveJson: (path: string, file: string, json: string) =>
    invoke<void>("save_json", { path, file, json }),
  saveChapter: (path: string, chapter: string, title: string, body: string) =>
    invoke<number>("save_chapter", { path, chapter, title, body }),
  deleteChapter: (path: string, chapter: string) =>
    invoke<void>("delete_chapter", { path, chapter }),
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
  countText: (text: string) => invoke<number>("count_text", { text }),
  readImportFile: (path: string) => invoke<ImportDoc>("read_import_file", { path }),
  imageData: (path: string) => invoke<string>("image_data", { path }),
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
