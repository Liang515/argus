//! 讀「終端機」App 目前的預設配色，給 Argus 的「跟隨終端機」配色用。

use std::collections::BTreeMap;
use std::io::Cursor;
use std::process::Command;

use plist::Value;

/// 「終端機」設定裡的顏色鍵 → xterm.js 的主題鍵。
const COLOR_KEYS: [(&str, &str); 20] = [
    ("BackgroundColor", "background"),
    ("TextColor", "foreground"),
    ("CursorColor", "cursor"),
    ("SelectionColor", "selectionBackground"),
    ("ANSIBlackColor", "black"),
    ("ANSIRedColor", "red"),
    ("ANSIGreenColor", "green"),
    ("ANSIYellowColor", "yellow"),
    ("ANSIBlueColor", "blue"),
    ("ANSIMagentaColor", "magenta"),
    ("ANSICyanColor", "cyan"),
    ("ANSIWhiteColor", "white"),
    ("ANSIBrightBlackColor", "brightBlack"),
    ("ANSIBrightRedColor", "brightRed"),
    ("ANSIBrightGreenColor", "brightGreen"),
    ("ANSIBrightYellowColor", "brightYellow"),
    ("ANSIBrightBlueColor", "brightBlue"),
    ("ANSIBrightMagentaColor", "brightMagenta"),
    ("ANSIBrightCyanColor", "brightCyan"),
    ("ANSIBrightWhiteColor", "brightWhite"),
];

fn hex(components: &[f64]) -> Option<String> {
    let channel = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    match components {
        [r, g, b, ..] => Some(format!(
            "#{:02x}{:02x}{:02x}",
            channel(*r),
            channel(*g),
            channel(*b)
        )),
        [w, ..] => Some(format!("#{0:02x}{0:02x}{0:02x}", channel(*w))),
        [] => None,
    }
}

fn floats(data: &[u8]) -> Vec<f64> {
    String::from_utf8_lossy(data)
        .trim_end_matches('\0')
        .split_whitespace()
        .filter_map(|n| n.parse().ok())
        .collect()
}

/// 「終端機」把顏色存成 NSKeyedArchiver 封存的 NSColor：在 `$objects` 裡找 RGB 或灰階數值。
pub fn color_from_archive(blob: &[u8]) -> Option<String> {
    let archive = Value::from_reader(Cursor::new(blob)).ok()?;
    let objects = archive.as_dictionary()?.get("$objects")?.as_array()?;
    objects
        .iter()
        .filter_map(Value::as_dictionary)
        .find_map(|obj| {
            ["NSRGB", "NSComponents", "NSWhite"]
                .iter()
                .find_map(|key| obj.get(key).and_then(Value::as_data))
                .and_then(|data| hex(&floats(data)))
        })
}

/// 從 `defaults export com.apple.Terminal -` 的內容取出預設描述檔的配色。
pub fn theme_from_export(export: &[u8]) -> Option<BTreeMap<String, String>> {
    let prefs = Value::from_reader(Cursor::new(export)).ok()?;
    let prefs = prefs.as_dictionary()?;
    let name = prefs.get("Default Window Settings")?.as_string()?;
    let profile = prefs
        .get("Window Settings")?
        .as_dictionary()?
        .get(name)?
        .as_dictionary()?;
    let theme: BTreeMap<String, String> = COLOR_KEYS
        .iter()
        .filter_map(|(from, to)| {
            let blob = profile.get(from)?.as_data()?;
            Some((to.to_string(), color_from_archive(blob)?))
        })
        .collect();
    // 至少要有背景和文字顏色才算讀到
    (theme.contains_key("background") && theme.contains_key("foreground")).then_some(theme)
}

/// 讀不到（沒用過「終端機」、或用的是沒存進設定檔的內建描述檔）時回傳 None。
#[tauri::command]
pub async fn terminal_app_theme() -> Option<BTreeMap<String, String>> {
    let out = Command::new("/usr/bin/defaults")
        .args(["export", "com.apple.Terminal", "-"])
        .output()
        .ok()?;
    out.status.success().then_some(())?;
    theme_from_export(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use plist::{Dictionary, Value};

    fn archived(key: &str, value: &[u8]) -> Vec<u8> {
        let mut color = Dictionary::new();
        color.insert(key.into(), Value::Data(value.to_vec()));
        color.insert("NSColorSpace".into(), Value::Integer(2.into()));
        let mut root = Dictionary::new();
        root.insert(
            "$objects".into(),
            Value::Array(vec![
                Value::String("$null".into()),
                Value::Dictionary(color),
            ]),
        );
        let mut out = Vec::new();
        Value::Dictionary(root).to_writer_binary(&mut out).unwrap();
        out
    }

    #[test]
    fn decodes_archived_colors() {
        // Clear Dark 的背景（含透明度，忽略 alpha）
        assert_eq!(
            color_from_archive(&archived(
                "NSRGB",
                b"0.09838771145 0.1138777476 0.152602838 0.95\0"
            )),
            Some("#191d27".into())
        );
        assert_eq!(
            color_from_archive(&archived("NSWhite", b"1\0")),
            Some("#ffffff".into())
        );
        assert_eq!(color_from_archive(b"not a plist"), None);
    }

    #[test]
    fn reads_the_default_profile() {
        let mut profile = Dictionary::new();
        profile.insert(
            "BackgroundColor".into(),
            Value::Data(archived("NSRGB", b"0 0 0\0")),
        );
        profile.insert(
            "TextColor".into(),
            Value::Data(archived("NSRGB", b"1 0.5 0\0")),
        );
        profile.insert(
            "ANSIRedColor".into(),
            Value::Data(archived("NSRGB", b"1 0 0\0")),
        );
        let mut other = Dictionary::new();
        other.insert(
            "BackgroundColor".into(),
            Value::Data(archived("NSRGB", b"1 1 1\0")),
        );
        let mut settings = Dictionary::new();
        settings.insert("Mine".into(), Value::Dictionary(profile));
        settings.insert("Other".into(), Value::Dictionary(other));
        let mut prefs = Dictionary::new();
        prefs.insert(
            "Default Window Settings".into(),
            Value::String("Mine".into()),
        );
        prefs.insert("Window Settings".into(), Value::Dictionary(settings));
        let mut xml = Vec::new();
        Value::Dictionary(prefs).to_writer_xml(&mut xml).unwrap();

        let theme = theme_from_export(&xml).unwrap();
        assert_eq!(theme["background"], "#000000");
        assert_eq!(theme["foreground"], "#ff8000");
        assert_eq!(theme["red"], "#ff0000");
    }

    #[test]
    fn missing_profile_or_colors_gives_none() {
        let mut prefs = Dictionary::new();
        prefs.insert(
            "Default Window Settings".into(),
            Value::String("Basic".into()),
        );
        let mut xml = Vec::new();
        Value::Dictionary(prefs).to_writer_xml(&mut xml).unwrap();
        assert_eq!(theme_from_export(&xml), None);
    }
}
