//! 側欄「活動」面板的資料：把 Claude Code hook 的原始 JSON 整理成一行精簡摘要。
//!
//! hook 會執行 `argus --hook-summary`，從 stdin 讀原始資料、把摘要印到 stdout，
//! 再和燈號一樣用 OSC 7777 寫到 agent 所在的終端機（背景對話被 attach 時也會轉送）。
//! 原始資料可能很大（寫入整個檔案時會附上全文），所以只留畫面需要的欄位並截短。

use std::io::Read;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

/// 顯示用文字的長度上限（字元數）。
const MAX_TEXT: usize = 120;
/// 滑鼠移上去看的完整內容（例如整行指令）的長度上限。
const MAX_DETAIL: usize = 400;
/// 計畫清單最多帶幾項、每項幾個字：整個摘要要小，和畫面輸出一起寫進終端機時才不容易被切斷。
const MAX_TODOS: usize = 20;
const MAX_TODO_TEXT: usize = 80;
/// hook 原始資料最多讀多少（寫入大檔時 tool_input 會很大）。
const MAX_PAYLOAD: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
#[serde(tag = "k", rename_all = "lowercase")]
pub enum Event {
    /// 使用者送出的訊息
    Prompt { text: String },
    /// 開始用一個工具
    Start {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        verb: &'static str,
        target: String,
        /// 修改或寫入時增加的行數
        #[serde(skip_serializing_if = "Option::is_none")]
        add: Option<i64>,
        /// 滑鼠移上去看的完整內容（執行指令時是整行指令）
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
    /// 工具執行完
    End {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        ok: bool,
    },
    /// Claude 的計畫清單（TodoWrite）
    Todos { items: Vec<Todo> },
    /// 這一輪回覆結束
    Stop,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Todo {
    pub text: String,
    /// pending / in_progress / completed
    pub status: String,
}

fn clip_to(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max - 1).collect();
        format!("{cut}…")
    }
}

/// 第一個非空白行，截到 MAX_TEXT。
fn clip(s: &str) -> String {
    clip_to(
        s.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .trim(),
        MAX_TEXT,
    )
}

/// 專案裡的檔案顯示相對路徑，外面的顯示完整路徑。
fn display_path(path: &str, cwd: Option<&str>) -> String {
    let relative = cwd
        .and_then(|cwd| Path::new(path).strip_prefix(cwd).ok())
        .map(|p| p.to_string_lossy().into_owned());
    clip(relative.as_deref().unwrap_or(path))
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn line_count(s: &str) -> i64 {
    if s.is_empty() {
        0
    } else {
        s.lines().count() as i64
    }
}

/// 執行指令：優先顯示 Claude 附的簡短說明（比原始指令好懂），完整指令放在 detail。
fn describe_command(input: &Value) -> (String, Option<String>) {
    let command = str_of(input, "command").trim();
    let description = str_of(input, "description").trim();
    let detail = (!command.is_empty()).then(|| clip_to(command, MAX_DETAIL));
    if description.is_empty() {
        (clip(command), detail)
    } else {
        (clip(description), detail)
    }
}

/// 工具名稱 → 動作、對象、增加行數。TodoWrite、Bash 另外處理。
fn describe(tool: &str, input: &Value, cwd: Option<&str>) -> (&'static str, String, Option<i64>) {
    let path = || display_path(str_of(input, "file_path"), cwd);
    match tool {
        "Read" => ("read", path(), None),
        "Write" => ("write", path(), Some(line_count(str_of(input, "content")))),
        "Edit" => (
            "edit",
            path(),
            Some(line_count(str_of(input, "new_string")) - line_count(str_of(input, "old_string"))),
        ),
        "MultiEdit" => {
            let add = input.get("edits").and_then(Value::as_array).map(|edits| {
                edits
                    .iter()
                    .map(|e| {
                        line_count(str_of(e, "new_string")) - line_count(str_of(e, "old_string"))
                    })
                    .sum()
            });
            ("edit", path(), add)
        }
        "NotebookEdit" => (
            "edit",
            display_path(str_of(input, "notebook_path"), cwd),
            None,
        ),
        "Grep" | "Glob" => ("search", clip(str_of(input, "pattern")), None),
        "WebFetch" => ("web", clip(str_of(input, "url")), None),
        "WebSearch" => ("web", clip(str_of(input, "query")), None),
        "Task" | "Agent" => ("agent", clip(str_of(input, "description")), None),
        other => ("other", clip(other), None),
    }
}

fn failed(response: Option<&Value>) -> bool {
    let Some(r) = response else { return false };
    r.get("is_error").and_then(Value::as_bool).unwrap_or(false)
        || r.get("interrupted")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

/// 整理一筆 hook 資料；不需要顯示的事件（SessionStart、Notification…）回傳 None。
pub fn summarize(payload: &str) -> Option<Event> {
    let v: Value = serde_json::from_str(payload).ok()?;
    let cwd = v.get("cwd").and_then(Value::as_str);
    let tool = str_of(&v, "tool_name");
    let id = v
        .get("tool_use_id")
        .and_then(Value::as_str)
        .map(str::to_string);
    let input = v.get("tool_input").cloned().unwrap_or(Value::Null);
    match str_of(&v, "hook_event_name") {
        "UserPromptSubmit" => Some(Event::Prompt {
            text: clip(str_of(&v, "prompt")),
        }),
        "PreToolUse" if tool == "TodoWrite" => {
            let items = input
                .get("todos")
                .and_then(Value::as_array)?
                .iter()
                .take(MAX_TODOS)
                .map(|t| Todo {
                    text: clip_to(clip(str_of(t, "content")).as_str(), MAX_TODO_TEXT),
                    status: str_of(t, "status").to_string(),
                })
                .collect();
            Some(Event::Todos { items })
        }
        "PreToolUse" if tool == "Bash" => {
            let (target, detail) = describe_command(&input);
            Some(Event::Start {
                id,
                verb: "run",
                target,
                add: None,
                detail,
            })
        }
        "PreToolUse" => {
            let (verb, target, add) = describe(tool, &input, cwd);
            Some(Event::Start {
                id,
                verb,
                target,
                add,
                detail: None,
            })
        }
        "PostToolUse" if tool == "TodoWrite" => None,
        "PostToolUse" => Some(Event::End {
            id,
            ok: !failed(v.get("tool_response")),
        }),
        // 工具失敗時 Claude 不送 PostToolUse，改送這個
        "PostToolUseFailure" => Some(Event::End { id, ok: false }),
        "Stop" => Some(Event::Stop),
        _ => None,
    }
}

/// `argus --hook-summary`：讀 stdin、印出一行 JSON 摘要（沒有可顯示的就不印）。
pub fn hook_summary_main() {
    let mut payload = String::new();
    if std::io::stdin()
        .take(MAX_PAYLOAD)
        .read_to_string(&mut payload)
        .is_err()
    {
        return;
    }
    if let Some(event) = summarize(&payload)
        && let Ok(line) = serde_json::to_string(&event)
    {
        println!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(payload: Value) -> Option<Event> {
        summarize(&payload.to_string())
    }

    #[test]
    fn prompt_and_stop() {
        assert_eq!(
            run(json!({"hook_event_name": "UserPromptSubmit", "prompt": "做側欄活動面板\n第二行"})),
            Some(Event::Prompt {
                text: "做側欄活動面板".into()
            })
        );
        assert_eq!(run(json!({"hook_event_name": "Stop"})), Some(Event::Stop));
        assert_eq!(run(json!({"hook_event_name": "SessionStart"})), None);
        assert_eq!(summarize("not json"), None);
    }

    #[test]
    fn tools_become_short_actions() {
        let start = |tool: &str, input: Value| {
            run(json!({
                "hook_event_name": "PreToolUse", "cwd": "/p", "tool_name": tool,
                "tool_use_id": "t1", "tool_input": input
            }))
        };
        assert_eq!(
            start("Read", json!({"file_path": "/p/src/a.ts"})),
            Some(Event::Start {
                id: Some("t1".into()),
                verb: "read",
                target: "src/a.ts".into(),
                add: None,
                detail: None
            })
        );
        // 寫入整個檔案：只帶行數，不帶內容
        let big = "x\n".repeat(5000);
        let Some(Event::Start { verb, add, .. }) = start(
            "Write",
            json!({"file_path": "/elsewhere/b.md", "content": big}),
        ) else {
            panic!()
        };
        assert_eq!((verb, add), ("write", Some(5000)));
        let Some(Event::Start { add, .. }) = start(
            "Edit",
            json!({"file_path": "/p/c.rs", "old_string": "a", "new_string": "a\nb\nc"}),
        ) else {
            panic!()
        };
        assert_eq!(add, Some(2));
        let Some(Event::Start {
            verb,
            target,
            detail,
            ..
        }) = start("Bash", json!({"command": "npm test\n&& echo done"}))
        else {
            panic!()
        };
        assert_eq!((verb, target.as_str()), ("run", "npm test"));
        assert_eq!(detail.as_deref(), Some("npm test\n&& echo done"));
        // 有說明就顯示說明，完整指令放 detail
        let Some(Event::Start { target, detail, .. }) = start(
            "Bash",
            json!({"command": "cargo test --quiet 2>&1 | tail", "description": "跑 Rust 測試"}),
        ) else {
            panic!()
        };
        assert_eq!(target, "跑 Rust 測試");
        assert_eq!(detail.as_deref(), Some("cargo test --quiet 2>&1 | tail"));
    }

    #[test]
    fn long_text_is_clipped() {
        let Some(Event::Start { target, .. }) = run(json!({
            "hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": "x".repeat(500)}
        })) else {
            panic!()
        };
        assert_eq!(target.chars().count(), MAX_TEXT);
        assert!(target.ends_with('…'));
    }

    #[test]
    fn todos_and_results() {
        assert_eq!(
            run(json!({
                "hook_event_name": "PreToolUse", "tool_name": "TodoWrite",
                "tool_input": {"todos": [
                    {"content": "讀程式", "status": "completed", "activeForm": "讀程式中"},
                    {"content": "補測試", "status": "in_progress"}
                ]}
            })),
            Some(Event::Todos {
                items: vec![
                    Todo {
                        text: "讀程式".into(),
                        status: "completed".into()
                    },
                    Todo {
                        text: "補測試".into(),
                        status: "in_progress".into()
                    },
                ]
            })
        );
        assert_eq!(
            run(
                json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "t9",
                       "tool_response": {"interrupted": true}})
            ),
            Some(Event::End {
                id: Some("t9".into()),
                ok: false
            })
        );
        assert_eq!(
            run(
                json!({"hook_event_name": "PostToolUse", "tool_name": "Read", "tool_response": {}})
            ),
            Some(Event::End { id: None, ok: true })
        );
    }

    #[test]
    fn todos_are_capped_to_keep_the_summary_small() {
        let todos: Vec<Value> = (0..30)
            .map(|i| json!({"content": format!("{i} {}", "很長的待辦".repeat(40)), "status": "pending"}))
            .collect();
        let Some(Event::Todos { items }) = run(json!({
            "hook_event_name": "PreToolUse", "tool_name": "TodoWrite",
            "tool_input": {"todos": todos}
        })) else {
            panic!()
        };
        assert_eq!(items.len(), MAX_TODOS);
        assert!(
            items
                .iter()
                .all(|t| t.text.chars().count() <= MAX_TODO_TEXT)
        );
        let line = serde_json::to_string(&Event::Todos { items }).unwrap();
        assert!(line.len() < 6 * 1024, "{} bytes", line.len());
    }

    /// 真實的失敗事件（Claude Code 2.1.286 錄下來的欄位）
    #[test]
    fn tool_failures_are_marked() {
        assert_eq!(
            run(json!({
                "hook_event_name": "PostToolUseFailure", "tool_name": "Bash",
                "tool_use_id": "toolu_x", "error": "Exit code 1", "is_interrupt": false,
                "duration_ms": 12, "tool_input": {"command": "false"}
            })),
            Some(Event::End {
                id: Some("toolu_x".into()),
                ok: false
            })
        );
    }

    #[test]
    fn summary_line_has_no_control_characters() {
        let event = run(json!({"hook_event_name": "UserPromptSubmit", "prompt": "a\u{7}b\u{1b}c"}))
            .unwrap();
        let line = serde_json::to_string(&event).unwrap();
        assert!(
            !line.contains('\u{7}') && !line.contains('\u{1b}'),
            "{line}"
        );
    }
}
