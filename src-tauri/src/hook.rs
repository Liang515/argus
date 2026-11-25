//! Windows 的狀態回報：hook 呼叫 `argus.exe --hook <狀態> [agent]`，經 named pipe 送回執行中的 Argus。
//!
//! macOS 的 hook 是 shell 腳本，把 OSC 7777 寫進分頁的終端機裝置；Windows（ConPTY）沒有
//! 終端機裝置可寫，所以改由 Argus 執行檔自己整理狀態與活動摘要，交給 Argus 開的 pipe，
//! 再以 `argus-hook` 事件送給前端，前端照處理 OSC 7777 的方式處理（訊息內容完全相同）。

// pipe 的接收端只有 Windows 用得到；macOS 照樣編譯與測試訊息格式
#![cfg_attr(not(windows), allow(dead_code))]

use serde::{Deserialize, Serialize};

use crate::activity;

/// pipe 名稱與分頁 id 由 Argus 開分頁時放進環境變數，hook 從 agent 繼承。
pub const PIPE_ENV: &str = "ARGUS_PIPE";
pub const TAB_ENV: &str = "ARGUS_TAB_ID";

/// 一則訊息的上限；活動摘要已經裁短過，正常遠小於這個大小。
pub const MAX_MESSAGE: usize = 256 * 1024;

/// hook 送給 Argus 的一則訊息：哪個分頁、依序要處理的 OSC 7777 內容（不含 `7777;`）。
#[derive(Debug, PartialEq, Serialize, Deserialize, Clone)]
pub struct HookMessage {
    pub id: String,
    pub osc: Vec<String>,
}

/// Claude 的 Notification 事件要看內容才知道是「等你確認」還是「做完在等下一句」。
fn classify<'a>(state: &'a str, payload: &str) -> &'a str {
    if state != "notify" {
        return state;
    }
    if payload.contains("idle_prompt") || payload.contains("waiting for your input") {
        "done"
    } else {
        "needs-input"
    }
}

/// 狀態加上活動摘要，順序和 macOS hook 寫進終端機的一樣（先燈號，前端才知道活動是哪個 agent 的）。
pub fn osc_messages(state: &str, agent: Option<&str>, payload: &str) -> Vec<String> {
    let state = classify(state, payload);
    let mut out = vec![match agent {
        Some(agent) => format!("argus;{state};{agent}"),
        None => format!("argus;{state}"),
    }];
    if let Some(event) = activity::summarize(payload)
        && let Ok(json) = serde_json::to_string(&event)
    {
        out.push(format!("argus-activity;{json}"));
    }
    out
}

/// 狀態只能是固定幾種，agent 只能是 agy；其他參數一律不送，避免把任意文字塞進前端。
fn parse_args(args: &[String]) -> Option<(&str, Option<&str>)> {
    let state = args.first()?.as_str();
    if !matches!(
        state,
        "idle" | "running" | "notify" | "needs-input" | "done" | "off"
    ) {
        return None;
    }
    let agent = match args.get(1).map(String::as_str) {
        None => None,
        Some("agy") => Some("agy"),
        Some(_) => return None,
    };
    Some((state, agent))
}

/// `argus --hook <狀態> [agent]`：讀 stdin 的 hook 資料，送給 Argus 後結束。
/// agy 的 hook 一定要在 stdout 回 JSON，所以不管成敗都印 `{}`。
pub fn hook_main(args: &[String]) {
    use std::io::Read;
    let parsed = parse_args(args);
    let mut payload = String::new();
    let _ = std::io::stdin()
        .take(activity::MAX_PAYLOAD)
        .read_to_string(&mut payload);
    if let Some((state, agent)) = parsed
        && let (Ok(pipe), Ok(id)) = (std::env::var(PIPE_ENV), std::env::var(TAB_ENV))
    {
        let message = HookMessage {
            id,
            osc: osc_messages(state, agent, &payload),
        };
        if let Ok(bytes) = serde_json::to_vec(&message) {
            send(&pipe, &bytes);
        }
    }
    if parsed.is_some_and(|(_, agent)| agent == Some("agy")) {
        println!("{{}}");
    }
}

/// 解析 pipe 收到的訊息；格式不對或太大就丟掉。
pub fn parse_message(bytes: &[u8]) -> Option<HookMessage> {
    if bytes.len() > MAX_MESSAGE {
        return None;
    }
    let message: HookMessage = serde_json::from_slice(bytes).ok()?;
    let valid = !message.id.is_empty()
        && message.id.len() <= 200
        && message.osc.len() <= 4
        && message
            .osc
            .iter()
            .all(|o| o.starts_with("argus;") || o.starts_with("argus-activity;"));
    valid.then_some(message)
}

/// 最多等 1 秒：Argus 卡住或沒開時放棄這次燈號，不拖住 agent（hook 跑完 agent 才會繼續）。
#[cfg(windows)]
fn send(pipe: &str, bytes: &[u8]) {
    use std::io::Write;
    use std::time::{Duration, Instant};
    const ERROR_PIPE_BUSY: i32 = 231;
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match std::fs::OpenOptions::new().write(true).open(pipe) {
            Ok(mut file) => {
                let _ = file.write_all(bytes);
                return;
            }
            // 所有 pipe 執行個體都在忙（別的 hook 剛好也在送）：稍等再試
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) && Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return,
        }
    }
}

#[cfg(not(windows))]
fn send(_pipe: &str, _bytes: &[u8]) {}

/// 每次啟動用不同名稱：同時開兩個 Argus 不會互搶，別的程式也猜不到要先佔用哪個名稱。
#[cfg(windows)]
pub fn new_pipe_name() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!(r"\\.\pipe\argus-{}-{nanos:x}", std::process::id())
}

/// 在背景監聽 pipe，每則訊息轉成 `argus-hook` 事件給前端。
#[cfg(windows)]
pub fn serve(app: tauri::AppHandle, name: String) {
    use tauri::Emitter;
    listen(name, move |message| {
        let _ = app.emit("argus-hook", message);
    });
}

/// 在背景接收 hook 的連線，每則合格的訊息依連線順序交給 `on_message`。
///
/// 每個連線各自讀取（慢的連線不擋住下一個連線），但結果照連線順序處理：
/// 緊接著的兩個 hook（例如 PostToolUse 後馬上 Stop）不會反過來，燈號才不會停在舊狀態。
#[cfg(windows)]
fn listen(name: String, on_message: impl Fn(HookMessage) + Send + 'static) {
    use tokio::io::AsyncReadExt;
    use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
    use tokio::sync::{mpsc, oneshot};

    // 只收不送（PIPE_ACCESS_INBOUND）：連線端一定要有寫入權限，預設權限下只有目前使用者與管理員
    let create = move |first: bool| -> std::io::Result<NamedPipeServer> {
        ServerOptions::new()
            .first_pipe_instance(first)
            .access_outbound(false)
            .reject_remote_clients(true)
            .create(&name)
    };

    let (order_tx, mut order_rx) = mpsc::unbounded_channel::<oneshot::Receiver<HookMessage>>();
    tauri::async_runtime::spawn(async move {
        while let Some(result) = order_rx.recv().await {
            // 讀取失敗或格式不對的連線沒有訊息，略過
            if let Ok(message) = result.await {
                on_message(message);
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        // first_pipe_instance：名稱已被別的程式佔用就不要接（避免收到假的訊息或被搶走）
        let mut server = match create(true) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("狀態回報 pipe 建立失敗：{e}");
                return;
            }
        };
        loop {
            let connected = server.connect().await.is_ok();
            let client = server;
            // 每個連線用掉一個執行個體，先開好下一個再處理；連線失敗的那個直接丟掉
            server = match create(false) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("狀態回報 pipe 建立失敗：{e}");
                    return;
                }
            };
            if !connected {
                continue;
            }
            let (tx, rx) = oneshot::channel();
            if order_tx.send(rx).is_err() {
                return;
            }
            tauri::async_runtime::spawn(async move {
                let mut buf = Vec::new();
                let mut limited = client.take(MAX_MESSAGE as u64 + 1);
                let read = limited.read_to_end(&mut buf);
                // hook 寫完就關閉連線；卡住的連線 2 秒後放棄
                if tokio::time::timeout(std::time::Duration::from_secs(2), read)
                    .await
                    .is_ok_and(|r| r.is_ok())
                    && let Some(message) = parse_message(&buf)
                {
                    let _ = tx.send(message);
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn notifications_are_classified_like_the_shell_hook() {
        assert_eq!(
            osc_messages(
                "notify",
                None,
                r#"{"notification_type":"permission_prompt"}"#
            ),
            vec!["argus;needs-input"]
        );
        assert_eq!(
            osc_messages("notify", None, r#"{"notification_type":"idle_prompt"}"#),
            vec!["argus;done"]
        );
        assert_eq!(
            osc_messages("running", Some("agy"), ""),
            vec!["argus;running;agy"]
        );
    }

    #[test]
    fn activity_summary_follows_the_status() {
        let payload = r#"{"hook_event_name":"UserPromptSubmit","prompt":"fix it","cwd":"C:\\p"}"#;
        let osc = osc_messages("running", None, payload);
        assert_eq!(osc.len(), 2);
        assert_eq!(osc[0], "argus;running");
        assert!(osc[1].starts_with("argus-activity;{"), "{osc:?}");
        assert!(osc[1].contains("fix it"));
    }

    #[test]
    fn only_known_states_and_agents_are_accepted() {
        assert_eq!(parse_args(&args(&["done"])), Some(("done", None)));
        assert_eq!(
            parse_args(&args(&["idle", "agy"])),
            Some(("idle", Some("agy")))
        );
        assert_eq!(parse_args(&args(&[])), None);
        assert_eq!(parse_args(&args(&["running;x"])), None);
        assert_eq!(parse_args(&args(&["running", "codex"])), None);
    }

    /// 真的開 named pipe：hook 端送出的訊息，Argus 端依序收到；格式不對的丟掉。
    #[cfg(windows)]
    #[test]
    fn messages_travel_through_the_pipe() {
        use std::sync::mpsc;
        use std::time::{Duration, Instant};
        let name = new_pipe_name();
        let (tx, rx) = mpsc::channel();
        listen(name.clone(), move |m| {
            let _ = tx.send(m);
        });
        let message = HookMessage {
            id: "tab-1".into(),
            osc: osc_messages("notify", Some("agy"), r#"{"notification_type":"x"}"#),
        };
        let bytes = serde_json::to_vec(&message).unwrap();
        // pipe 在背景建立，建好之前送出會直接失敗（和 Argus 沒開時一樣），所以重送到收到為止
        let deadline = Instant::now() + Duration::from_secs(5);
        let received = loop {
            send(&name, b"garbage");
            send(&name, &bytes);
            if let Ok(m) = rx.recv_timeout(Duration::from_millis(200)) {
                break m;
            }
            assert!(Instant::now() < deadline, "pipe 沒收到訊息");
        };
        assert_eq!(received, message);
        assert_eq!(received.osc, vec!["argus;needs-input;agy"]);

        // 連續送出的訊息照順序到達
        let states = ["running", "done", "running", "needs-input", "done", "off"];
        for (i, state) in states.iter().enumerate() {
            let m = HookMessage {
                id: format!("seq-{i}"),
                osc: vec![format!("argus;{state}")],
            };
            send(&name, &serde_json::to_vec(&m).unwrap());
        }
        // 前面重送的訊息可能還有幾則在路上，只看這一輪的
        let mut got = Vec::new();
        while got.len() < states.len() {
            let id = rx.recv_timeout(Duration::from_secs(5)).unwrap().id;
            if id.starts_with("seq-") {
                got.push(id);
            }
        }
        let want: Vec<String> = (0..states.len()).map(|i| format!("seq-{i}")).collect();
        assert_eq!(got, want);
    }

    #[test]
    fn messages_round_trip_and_bad_ones_are_dropped() {
        let message = HookMessage {
            id: "tab-1".into(),
            osc: osc_messages("done", None, "{}"),
        };
        let bytes = serde_json::to_vec(&message).unwrap();
        assert_eq!(parse_message(&bytes), Some(message));

        assert_eq!(parse_message(b"not json"), None);
        assert_eq!(parse_message(br#"{"id":"","osc":["argus;done"]}"#), None);
        assert_eq!(parse_message(br#"{"id":"t","osc":["52;c;aGk="]}"#), None);
        let huge = format!(
            r#"{{"id":"t","osc":["argus;{}"]}}"#,
            "x".repeat(MAX_MESSAGE)
        );
        assert_eq!(parse_message(huge.as_bytes()), None);
    }
}
