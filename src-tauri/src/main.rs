// 发布版不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // AI 客户端用 `chapter.exe --mcp-stdio` 接入；只做 JSON-RPC 转发，不打开界面。
    if std::env::args().any(|a| a == "--mcp-stdio") {
        chapter_lib::run_mcp_stdio();
        return;
    }
    chapter_lib::run()
}
