use chrono::{Datelike, Local, Timelike, TimeZone};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    collections::VecDeque,
    path::PathBuf,
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
    thread,
    time::{Duration, Instant},
    io::{BufReader, Cursor, Write},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use tauri_plugin_notification::NotificationExt;
use rodio::{Decoder, OutputStream, Sink, Source};
use base64::Engine;

// Included at compile time: self-contained Portable EXE; no external media file needed.
static DEFAULT_ALARM_MP3: &[u8] = include_bytes!("../resources/default_alarm.mp3");
const EXTRA_TIMER_LIMIT: usize = 5;
const AUDIO_FILE_MAX_BYTES: usize = 12 * 1024 * 1024;
const BACKUP_MAX_BYTES: usize = 256 * 1024;
const BACKUP_FORMAT: &str = "angeltime-backup";
const BACKUP_SCHEMA: u32 = 1;
// Catch up only recently missed alarms on resume, never the whole sleep period.
const ALARM_CATCH_UP_MS: i64 = 10 * 60 * 1000;


static NEXT_ID: AtomicU64 = AtomicU64::new(0);

// Existing alarms default to Custom without changing their saved repeat days.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
enum ScheduleMode { #[default] Custom, Workdays, Weekends }

fn normalized_work_days(days: &[u8]) -> Vec<u8> {
    let mut result: Vec<u8> = days.iter().copied().filter(|d| *d <= 6).collect();
    result.sort_unstable(); result.dedup(); result
}
fn scheduled_days(mode: ScheduleMode, custom: &[u8], work_days: &[u8]) -> Vec<u8> {
    match mode {
        ScheduleMode::Custom => normalized_work_days(custom),
        ScheduleMode::Workdays => work_days.to_vec(),
        ScheduleMode::Weekends => (0..7).filter(|day| !work_days.contains(day)).collect(),
    }
}


#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Alarm {
    id: String,
    hour: u8,
    minute: u8,
    label: String,
    days: Vec<u8>,
    schedule_mode: ScheduleMode,
    enabled: bool,
    last_fired_key: Option<String>,
}

impl Default for Alarm {
    fn default() -> Self {
        Self { id: String::new(), hour: 8, minute: 0, label: "Будильник".into(), days: vec![], schedule_mode: ScheduleMode::Custom, enabled: true, last_fired_key: None }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct TimerData {
    duration_seconds: u32,
    remaining_ms: u64,
    deadline_ms: Option<i64>,
    running: bool,
}

impl Default for TimerData {
    fn default() -> Self {
        Self { duration_seconds: 300, remaining_ms: 300_000, deadline_ms: None, running: false }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct ExtraTimer {
    id: String,
    title: String,
    timer: TimerData,
}
impl Default for ExtraTimer {
    fn default() -> Self {
        Self { id: String::new(), title: "Дополнительный таймер".into(), timer: TimerData::default() }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct StopwatchData {
    elapsed_ms: u64,
    started_at_ms: Option<i64>,
    laps: Vec<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Preferences {
    sound_enabled: bool,
    notifications_enabled: bool,
    reduced_motion: bool,
    alarm_melody: String, // 'default', 'system', or 'custom'
    alarm_volume: u8, // 0..=100, for MP3 music only
    fade_in_seconds: u8, // 0..=30
    custom_melody_name: String,
    work_days: Vec<u8>, // Monday=0 .. Sunday=6; complement is My weekends.
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            sound_enabled: true, notifications_enabled: true, reduced_motion: false,
            alarm_melody: "default".into(), alarm_volume: 75,
            fade_in_seconds: 5, custom_melody_name: String::new(), work_days: vec![0,1,2,3,4],
        }
    }
}

#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct Persisted {
    alarms: Vec<Alarm>,
    timer: TimerData,
    extra_timers: Vec<ExtraTimer>,
    stopwatch: StopwatchData,
    preferences: Preferences,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct Alert {
    kind: String,
    title: String,
    body: String,
}

#[derive(Clone, Serialize)]
struct TimerView {
    duration_seconds: u32,
    remaining_ms: u64,
    running: bool,
}

#[derive(Clone, Serialize)]
struct ExtraTimerView {
    id: String,
    title: String,
    duration_seconds: u32,
    remaining_ms: u64,
    running: bool,
}

#[derive(Clone, Serialize)]
struct StopwatchView {
    elapsed_ms: u64,
    running: bool,
    laps: Vec<u64>,
}

#[derive(Clone, Serialize)]
struct Snapshot {
    alarms: Vec<Alarm>,
    timer: TimerView,
    extra_timers: Vec<ExtraTimerView>,
    stopwatch: StopwatchView,
    alert: Option<Alert>,
    preferences: Preferences,
}

#[derive(Deserialize)]
struct AlarmDraft {
    #[serde(default)]
    schedule_mode: ScheduleMode,
    id: Option<String>,
    hour: u8,
    minute: u8,
    label: String,
    days: Vec<u8>,
    enabled: bool,
}

struct AppStore {
    data: Mutex<Persisted>,
    alert: Mutex<Option<Alert>>,
    pending_alerts: Mutex<VecDeque<Alert>>,
    file: PathBuf,
    ring_id: AtomicU64,
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

fn new_id() -> String {
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{}-{sequence}", Local::now().timestamp_micros())
}

fn remaining_timer_ms(timer: &TimerData, now: i64) -> u64 {
    if timer.running {
        // Signed subtraction may be negative after a deadline. Convert to u64
        // only after clamping, otherwise -1000 becomes an enormous u64 value.
        timer.deadline_ms.unwrap_or(now).saturating_sub(now).max(0) as u64
    } else {
        timer.remaining_ms
    }
}

fn stopwatch_elapsed_ms(stopwatch: &StopwatchData, now: i64) -> u64 {
    // The wall clock can move backwards (NTP/manual edits). A negative delta
    // must never wrap to u64::MAX and corrupt the accumulated stopwatch time.
    let live = stopwatch.started_at_ms
        .map(|start| now.saturating_sub(start).max(0) as u64)
        .unwrap_or(0);
    stopwatch.elapsed_ms.saturating_add(live)
}

fn snapshot(store: &AppStore, now: i64) -> Snapshot {
    let data = store.data.lock().unwrap_or_else(|p| p.into_inner());
    let alert = store.alert.lock().unwrap_or_else(|p| p.into_inner()).clone();
    Snapshot {
        alarms: data.alarms.clone(),
        timer: TimerView {
            duration_seconds: data.timer.duration_seconds,
            remaining_ms: remaining_timer_ms(&data.timer, now),
            running: data.timer.running,
        },
        extra_timers: data.extra_timers.iter().map(|entry| ExtraTimerView {
            id: entry.id.clone(), title: entry.title.clone(),
            duration_seconds: entry.timer.duration_seconds,
            remaining_ms: remaining_timer_ms(&entry.timer, now),
            running: entry.timer.running,
        }).collect(),
        stopwatch: StopwatchView {
            elapsed_ms: stopwatch_elapsed_ms(&data.stopwatch, now),
            running: data.stopwatch.started_at_ms.is_some(),
            laps: data.stopwatch.laps.clone(),
        },
        alert,
        preferences: data.preferences.clone(),
    }
}

fn save<T: Serialize>(path: &PathBuf, data: &T) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    let backup = path.with_extension("json.bak");
    fs::write(&temp, content).map_err(|e| e.to_string())?;
    // Windows does not replace an existing file with fs::rename. Keep a recovery copy.
    if path.exists() {
        if backup.exists() { fs::remove_file(&backup).map_err(|e| e.to_string())?; }
        fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    match fs::rename(&temp, path) {
        Ok(()) => { let _ = fs::remove_file(&backup); Ok(()) }
        Err(e) => {
            if backup.exists() { let _ = fs::rename(&backup, path); }
            Err(e.to_string())
        }
    }
}

fn load(path: &PathBuf) -> Persisted {
    for candidate in [path.clone(), path.with_extension("json.bak")] {
        if let Ok(content) = fs::read_to_string(candidate) {
            if let Ok(mut data) = serde_json::from_str::<Persisted>(&content) {
                data.alarms.truncate(32);
                data.stopwatch.laps.truncate(100);
                data.extra_timers.truncate(EXTRA_TIMER_LIMIT);
                data.extra_timers.retain(|e| (1..=359_999).contains(&e.timer.duration_seconds));
                for entry in &mut data.extra_timers {
                    if entry.timer.running && entry.timer.deadline_ms.is_none() {
                        entry.timer.running = false;
                    }
                    entry.title = entry.title.chars().take(40).collect();
                }
                if !valid_melody(&data.preferences.alarm_melody) {
                    data.preferences.alarm_melody = "default".into();
                }
                data.preferences.alarm_volume = data.preferences.alarm_volume.min(100);
                data.preferences.fade_in_seconds = data.preferences.fade_in_seconds.min(30);
                let work = normalized_work_days(&data.preferences.work_days);
                data.preferences.work_days = if (1..=6).contains(&work.len()) { work } else { vec![0,1,2,3,4] };
                // Recover consistency if the saved preferences or linked schedules changed.
                for alarm in &mut data.alarms {
                    if alarm.schedule_mode != ScheduleMode::Custom {
                        alarm.days = scheduled_days(alarm.schedule_mode, &[], &data.preferences.work_days);
                    }
                }
                if data.timer.duration_seconds == 0 || data.timer.duration_seconds > 359_999 {
                    data.timer = TimerData::default();
                }
                if data.timer.running && data.timer.deadline_ms.is_none() {
                    data.timer.running = false;
                }
                return data;
            }
        }
    }
    Persisted::default()
}

fn mutate<F>(app: &tauri::AppHandle, change: F) -> Result<Snapshot, String>
where F: FnOnce(&mut Persisted) -> Result<(), String> {
    let store = app.state::<AppStore>();
    {
        let mut data = store.data.lock().unwrap_or_else(|p| p.into_inner());
        let mut next = data.clone();
        change(&mut next)?;
        save(&store.file, &next)?;
        *data = next;
    }
    let result = snapshot(&store, now_ms());
    let _ = app.emit("angel:state", &result);
    Ok(result)
}


// Portable, deliberately small backup format. Runtime timers and audio files are
// excluded: restoring settings must not start old deadlines or import audio bytes.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupAlarm {
    hour: u8,
    minute: u8,
    label: String,
    days: Vec<u8>,
    schedule_mode: ScheduleMode,
    enabled: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BackupDocument {
    format: String,
    schema_version: u32,
    created_at: String,
    alarms: Vec<BackupAlarm>,
    preferences: Preferences,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportUndo {
    alarms: Vec<Alarm>,
    preferences: Preferences,
}

#[derive(Serialize)]
struct BackupExportInfo { path: String, alarms_count: usize }

#[derive(Serialize)]
struct BackupPreview {
    alarms_count: usize,
    created_at: String,
    custom_audio_unavailable: bool,
}

fn undo_file(path: &PathBuf) -> PathBuf {
    path.with_file_name("state.before-last-import.json")
}

fn validated_backup(content: &str) -> Result<BackupDocument, String> {
    if content.len() > BACKUP_MAX_BYTES {
        return Err("Файл резервной копии больше 256 КБ".into());
    }
    let document: BackupDocument = serde_json::from_str(content)
        .map_err(|_| "Неверный JSON или формат резервной копии AngelTime".to_string())?;
    if document.format != BACKUP_FORMAT || document.schema_version != BACKUP_SCHEMA {
        return Err("Неподдерживаемая версия резервной копии AngelTime".into());
    }
    if document.alarms.len() > 32 {
        return Err("В копии больше 32 будильников".into());
    }
    if document.created_at.len() > 64 ||
        chrono::DateTime::parse_from_rfc3339(&document.created_at).is_err() {
        return Err("Некорректная дата резервной копии".into());
    }
    validate_preferences(&document.preferences)?;
    for alarm in &document.alarms {
        if alarm.hour > 23 || alarm.minute > 59 ||
            alarm.label.trim().is_empty() || alarm.label.chars().count() > 60 ||
            alarm.label.chars().any(|ch| ch.is_control()) ||
            alarm.days.len() > 7 || alarm.days.iter().any(|day| *day > 6) {
            return Err("Недопустимые данные одного из будильников".into());
        }
    }
    Ok(document)
}

fn make_backup(data: &Persisted) -> BackupDocument {
    BackupDocument {
        format: BACKUP_FORMAT.into(), schema_version: BACKUP_SCHEMA,
        created_at: Local::now().to_rfc3339(),
        alarms: data.alarms.iter().map(|alarm| BackupAlarm {
            hour: alarm.hour, minute: alarm.minute, label: alarm.label.clone(),
            days: alarm.days.clone(), schedule_mode: alarm.schedule_mode,
            enabled: alarm.enabled,
        }).collect(),
        preferences: data.preferences.clone(),
    }
}

#[tauri::command]
fn backup_export(app: tauri::AppHandle) -> Result<BackupExportInfo, String> {
    let store = app.state::<AppStore>();
    let document = {
        let data = store.data.lock().unwrap_or_else(|p| p.into_inner());
        make_backup(&data)
    };
    let bytes = serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?;
    if bytes.len() > BACKUP_MAX_BYTES { return Err("Резервная копия слишком большая".into()); }
    let dir = app.path().download_dir().map_err(|e| format!("Не найдена папка «Загрузки»: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("Нет доступа к папке «Загрузки»: {e}"))?;
    let stamp = Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    for index in 0..100 {
        let suffix = if index == 0 { String::new() } else { format!("_{index}") };
        let path = dir.join(format!("AngelTime_Backup_{stamp}{suffix}.json"));
        let file = fs::OpenOptions::new().create_new(true).write(true).open(&path);
        let mut file = match file {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Не удалось создать копию: {error}")),
        };
        if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("Не удалось записать копию: {error}"));
        }
        return Ok(BackupExportInfo {
            path: path.to_string_lossy().into_owned(),
            alarms_count: document.alarms.len(),
        });
    }
    Err("Не удалось подобрать свободное имя для резервной копии".into())
}

#[tauri::command]
fn backup_preview(contents: String) -> Result<BackupPreview, String> {
    let doc = validated_backup(&contents)?;
    Ok(BackupPreview {
        alarms_count: doc.alarms.len(),
        created_at: doc.created_at,
        custom_audio_unavailable: doc.preferences.alarm_melody == "custom",
    })
}

#[tauri::command]
fn backup_status(app: tauri::AppHandle) -> bool {
    undo_file(&app.state::<AppStore>().file).is_file()
}

#[tauri::command]
fn backup_import(app: tauri::AppHandle, contents: String) -> Result<Snapshot, String> {
    let document = validated_backup(&contents)?;
    let store = app.state::<AppStore>();
    if store.alert.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        return Err("Сначала остановите текущий сигнал".into());
    }
    {
        let mut data = store.data.lock().unwrap_or_else(|p| p.into_inner());
        let undo = ImportUndo { alarms: data.alarms.clone(), preferences: data.preferences.clone() };
        let mut next = data.clone();
        let now = Local::now().format("%Y-%m-%d %H:%M").to_string();
        next.alarms = document.alarms.into_iter().map(|alarm| Alarm {
            id: new_id(), hour: alarm.hour, minute: alarm.minute,
            label: alarm.label.trim().to_string(),
            days: scheduled_days(alarm.schedule_mode, &alarm.days, &document.preferences.work_days),
            schedule_mode: alarm.schedule_mode, enabled: alarm.enabled,
            // Do not unexpectedly ring on the same minute the file was imported.
            last_fired_key: Some(now.clone()),
        }).collect();
        next.preferences = document.preferences;
        // The JSON does not contain audio bytes. Never silently play a local
        // custom file that might belong to another backup or computer.
        if next.preferences.alarm_melody == "custom" {
            next.preferences.alarm_melody = "default".into();
            next.preferences.custom_melody_name.clear();
        }
        // Durable recovery is written BEFORE the state replacement. If state
        // persistence fails, the original in-memory state is left unchanged.
        save(&undo_file(&store.file), &undo)?;
        save(&store.file, &next)?;
        *data = next;
    }
    store.ring_id.fetch_add(1, Ordering::Relaxed);
    let result = snapshot(&store, now_ms());
    let _ = app.emit("angel:state", &result);
    Ok(result)
}

#[tauri::command]
fn backup_undo(app: tauri::AppHandle) -> Result<Snapshot, String> {
    let store = app.state::<AppStore>();
    if store.alert.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        return Err("Сначала остановите текущий сигнал".into());
    }
    let path = undo_file(&store.file);
    let bytes = fs::read(&path).map_err(|_| "Точка отката не найдена".to_string())?;
    if bytes.len() > BACKUP_MAX_BYTES { return Err("Повреждена точка отката".into()); }
    let undo: ImportUndo = serde_json::from_slice(&bytes)
        .map_err(|_| "Не удалось прочитать точку отката".to_string())?;
    validate_preferences(&undo.preferences)?;
    if undo.alarms.len() > 32 || undo.alarms.iter().any(|a|
        a.hour > 23 || a.minute > 59 || a.days.len() > 7 ||
        a.days.iter().any(|d| *d > 6) || a.label.chars().count() > 60) {
        return Err("Повреждены сохранённые будильники".into());
    }
    {
        let mut data = store.data.lock().unwrap_or_else(|p| p.into_inner());
        let mut next = data.clone();
        next.alarms = undo.alarms;
        next.preferences = undo.preferences;
        if next.preferences.alarm_melody == "custom"
            && !store.file.with_file_name("custom_alarm.mp3").is_file() {
            next.preferences.alarm_melody = "default".into();
            next.preferences.custom_melody_name.clear();
        }
        save(&store.file, &next)?;
        *data = next;
    }
    let _ = fs::remove_file(path);
    store.ring_id.fetch_add(1, Ordering::Relaxed);
    let result = snapshot(&store, now_ms());
    let _ = app.emit("angel:state", &result);
    Ok(result)
}

#[tauri::command]
fn get_state(app: tauri::AppHandle) -> Snapshot {
    snapshot(&app.state::<AppStore>(), now_ms())
}

#[tauri::command]
fn upsert_alarm(app: tauri::AppHandle, alarm: AlarmDraft) -> Result<Snapshot, String> {
    if alarm.hour > 23 || alarm.minute > 59 || alarm.days.len() > 7 || alarm.days.iter().any(|d| *d > 6) {
        return Err("Некорректное время или дни недели".into());
    }
    let clean_label = alarm.label.trim().chars().take(60).collect::<String>();
    let label = if clean_label.is_empty() { "Будильник".to_owned() } else { clean_label };
    mutate(&app, |data| {
        let days = scheduled_days(alarm.schedule_mode, &alarm.days, &data.preferences.work_days);
        if let Some(ref id) = alarm.id {
            let target = data.alarms.iter_mut().find(|a| &a.id == id).ok_or("Будильник не найден")?;
            target.hour = alarm.hour;
            target.minute = alarm.minute;
            target.label = label;
            target.days = days;
            target.schedule_mode = alarm.schedule_mode;
            target.enabled = alarm.enabled;
            // Preserve fired-minute key: editing cannot retrigger the same occurrence.
        } else {
            if data.alarms.len() >= 32 { return Err("Максимум 32 будильника".into()); }
            data.alarms.push(Alarm {
                id: new_id(), hour: alarm.hour, minute: alarm.minute, label,
                days, schedule_mode: alarm.schedule_mode, enabled: alarm.enabled, last_fired_key: None,
            });
        }
        Ok(())
    })
}

#[tauri::command]
fn set_work_days(app: tauri::AppHandle, days: Vec<u8>) -> Result<Snapshot, String> {
    let days = normalized_work_days(&days);
    if !(1..=6).contains(&days.len()) {
        return Err("Выбери от одного до шести рабочих дней — выходные тоже должны остаться".into());
    }
    mutate(&app, |data| {
        data.preferences.work_days = days.clone();
        for alarm in &mut data.alarms {
            if alarm.schedule_mode != ScheduleMode::Custom {
                alarm.days = scheduled_days(alarm.schedule_mode, &[], &days);
                // Preserve last_fired_key for safe updates in the same minute.
            }
        }
        Ok(())
    })
}

#[tauri::command]
fn delete_alarm(app: tauri::AppHandle, id: String) -> Result<Snapshot, String> {
    mutate(&app, |data| {
        let before = data.alarms.len();
        data.alarms.retain(|alarm| alarm.id != id);
        if data.alarms.len() == before { return Err("Будильник не найден".into()); }
        Ok(())
    })
}

#[tauri::command]
fn toggle_alarm(app: tauri::AppHandle, id: String) -> Result<Snapshot, String> {
    mutate(&app, |data| {
        let alarm = data.alarms.iter_mut().find(|a| a.id == id).ok_or("Будильник не найден")?;
        alarm.enabled = !alarm.enabled;
        // Do not re-arm an already fired one-shot within the same minute.
        Ok(())
    })
}

#[tauri::command]
fn timer_start(app: tauri::AppHandle, seconds: u32) -> Result<Snapshot, String> {
    if !(1..=359_999).contains(&seconds) { return Err("Задайте время от 1 секунды до 99:59:59".into()); }
    mutate(&app, |data| {
        let deadline = now_ms().saturating_add(i64::from(seconds) * 1000);
        data.timer = TimerData { duration_seconds: seconds, remaining_ms: u64::from(seconds) * 1000, deadline_ms: Some(deadline), running: true };
        Ok(())
    })
}

#[tauri::command]
fn timer_pause(app: tauri::AppHandle) -> Result<Snapshot, String> {
    mutate(&app, |data| {
        if data.timer.running {
            data.timer.remaining_ms = remaining_timer_ms(&data.timer, now_ms());
            data.timer.deadline_ms = None;
            data.timer.running = false;
        }
        Ok(())
    })
}

#[tauri::command]
fn timer_resume(app: tauri::AppHandle) -> Result<Snapshot, String> {
    mutate(&app, |data| {
        if !data.timer.running && data.timer.remaining_ms > 0 {
            data.timer.deadline_ms = Some(now_ms().saturating_add(data.timer.remaining_ms as i64));
            data.timer.running = true;
        }
        Ok(())
    })
}

#[tauri::command]
fn timer_reset(app: tauri::AppHandle) -> Result<Snapshot, String> {
    mutate(&app, |data| {
        data.timer.running = false;
        data.timer.deadline_ms = None;
        data.timer.remaining_ms = u64::from(data.timer.duration_seconds) * 1000;
        Ok(())
    })
}

// Extra timers are independent of the original, confirmed-stable primary timer.
// A separate command namespace prevents unintended changes to legacy timer actions.
fn find_extra_mut<'a>(data: &'a mut Persisted, id: &str) -> Result<&'a mut ExtraTimer, String> {
    data.extra_timers.iter_mut().find(|entry| entry.id == id).ok_or_else(|| "Таймер не найден".into())
}

#[tauri::command]
fn extra_timer_add(app: tauri::AppHandle, seconds: u32) -> Result<Snapshot, String> {
    if !(1..=359_999).contains(&seconds) { return Err("Задайте время от 1 секунды до 99:59:59".into()); }
    mutate(&app, |data| {
        if data.extra_timers.len() >= EXTRA_TIMER_LIMIT { return Err("Максимум 5 дополнительных таймеров".into()); }
        let number = data.extra_timers.len() + 2;
        data.extra_timers.push(ExtraTimer {
            id: new_id(), title: format!("Таймер {number}"),
            timer: TimerData { duration_seconds: seconds, remaining_ms: u64::from(seconds) * 1000,
                deadline_ms: Some(now_ms().saturating_add(i64::from(seconds)*1000)), running: true },
        });
        Ok(())
    })
}

#[tauri::command]
fn extra_timer_action(app: tauri::AppHandle, id: String, action: String) -> Result<Snapshot, String> {
    mutate(&app, |data| {
        if action == "delete" {
            let before = data.extra_timers.len();
            data.extra_timers.retain(|entry| entry.id != id);
            if before == data.extra_timers.len() { return Err("Таймер не найден".into()); }
            return Ok(());
        }
        let entry = find_extra_mut(data, &id)?;
        match action.as_str() {
            "pause" => {
                if entry.timer.running {
                    entry.timer.remaining_ms = remaining_timer_ms(&entry.timer, now_ms());
                    entry.timer.deadline_ms = None;
                    entry.timer.running = false;
                }
            }
            "resume" => {
                if !entry.timer.running && entry.timer.remaining_ms > 0 {
                    entry.timer.deadline_ms = Some(now_ms().saturating_add(entry.timer.remaining_ms as i64));
                    entry.timer.running = true;
                }
            }
            "reset" => {
                entry.timer.running = false;
                entry.timer.deadline_ms = None;
                entry.timer.remaining_ms = u64::from(entry.timer.duration_seconds) * 1000;
            }
            "start" => {
                entry.timer.running = true;
                entry.timer.remaining_ms = u64::from(entry.timer.duration_seconds) * 1000;
                entry.timer.deadline_ms = Some(now_ms().saturating_add(entry.timer.remaining_ms as i64));
            }
            _ => return Err("Неизвестное действие с таймером".into()),
        }
        Ok(())
    })
}

#[tauri::command]
fn stopwatch_toggle(app: tauri::AppHandle) -> Result<Snapshot, String> {
    mutate(&app, |data| {
        let stopwatch = &mut data.stopwatch;
        if stopwatch.started_at_ms.is_some() {
            stopwatch.elapsed_ms = stopwatch_elapsed_ms(stopwatch, now_ms());
            stopwatch.started_at_ms = None;
        } else {
            stopwatch.started_at_ms = Some(now_ms());
        }
        Ok(())
    })
}

#[tauri::command]
fn stopwatch_lap(app: tauri::AppHandle) -> Result<Snapshot, String> {
    mutate(&app, |data| {
        if data.stopwatch.started_at_ms.is_none() { return Err("Сначала запустите секундомер".into()); }
        if data.stopwatch.laps.len() == 100 { data.stopwatch.laps.remove(0); }
        let elapsed = stopwatch_elapsed_ms(&data.stopwatch, now_ms());
        data.stopwatch.laps.push(elapsed);
        Ok(())
    })
}

#[tauri::command]
fn stopwatch_reset(app: tauri::AppHandle) -> Result<Snapshot, String> {
    mutate(&app, |data| { data.stopwatch = StopwatchData::default(); Ok(()) })
}

fn valid_melody(value: &str) -> bool { matches!(value, "default" | "system" | "custom") }
fn validate_preferences(p: &Preferences) -> Result<(), String> {
    if !valid_melody(&p.alarm_melody) || p.alarm_volume > 100 || p.fade_in_seconds > 30 {
        return Err("Некорректные настройки мелодии".into());
    }
    if normalized_work_days(&p.work_days) != p.work_days || !(1..=6).contains(&p.work_days.len()) {
        return Err("Некорректное расписание рабочих дней".into());
    }
    if p.custom_melody_name.chars().count() > 80 {
        return Err("Слишком длинное название мелодии".into());
    }
    Ok(())
}

#[tauri::command]
fn set_preferences(app: tauri::AppHandle, preferences: Preferences) -> Result<Snapshot, String> {
    validate_preferences(&preferences)?;
    if preferences.alarm_melody == "custom" {
        let store = app.state::<AppStore>();
        if !store.file.with_file_name("custom_alarm.mp3").exists() {
            return Err("Сначала импортируйте MP3-файл".into());
        }
    }
    let result = mutate(&app, |data| { data.preferences = preferences.clone(); Ok(()) })?;
    // Stop preview / ringing music whenever sound has been disabled.
    if !preferences.sound_enabled {
        app.state::<AppStore>().ring_id.fetch_add(1, Ordering::Relaxed);
    }
    Ok(result)
}

#[tauri::command]
fn import_alarm_audio(app: tauri::AppHandle, name: String, encoded: String) -> Result<Snapshot, String> {
    if !name.to_lowercase().ends_with(".mp3") || name.chars().count() > 200 {
        return Err("Выберите MP3-файл".into());
    }
    if encoded.len() > ((AUDIO_FILE_MAX_BYTES + 2) / 3) * 4 + 8 {
        return Err("Максимальный размер MP3 — 12 МБ".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(&encoded)
        .map_err(|_| "Не удалось прочитать MP3-файл")?;
    if bytes.is_empty() || bytes.len() > AUDIO_FILE_MAX_BYTES || !looks_like_mp3(&bytes) {
        return Err("Неверный MP3 или размер больше 12 МБ".into());
    }
    // Verify decoding before replacing an existing selected song.
    Decoder::new(BufReader::new(Cursor::new(bytes.clone())))
        .map_err(|_| "Не удалось декодировать MP3")?;
    let store = app.state::<AppStore>();
    let file = store.file.with_file_name("custom_alarm.mp3");
    let temp = store.file.with_file_name("custom_alarm.mp3.tmp");
    fs::write(&temp, &bytes).map_err(|e| e.to_string())?;
    // Windows cannot rename over an existing target. Keep a recovery copy.
    let backup = store.file.with_file_name("custom_alarm.mp3.bak");
    if file.exists() {
        if backup.exists() { fs::remove_file(&backup).map_err(|e| e.to_string())?; }
        fs::rename(&file, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&temp, &file) {
        if backup.exists() { let _ = fs::rename(&backup, &file); }
        return Err(error.to_string());
    }
    let _ = fs::remove_file(&backup);
    let clean_name = name.chars().filter(|c| !c.is_control()).take(80).collect::<String>();
    mutate(&app, |data| {
        data.preferences.custom_melody_name = clean_name;
        data.preferences.alarm_melody = "custom".into();
        Ok(())
    })
}

fn looks_like_mp3(bytes: &[u8]) -> bool {
    bytes.starts_with(b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0)
}

#[tauri::command]
fn preview_sound(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.state::<AppStore>();
    if store.alert.lock().unwrap_or_else(|p| p.into_inner()).is_some() {
        return Err("Сначала остановите текущий сигнал".into());
    }
    let preferences = store.data.lock().unwrap_or_else(|p| p.into_inner()).preferences.clone();
    let token = store.ring_id.fetch_add(1, Ordering::Relaxed) + 1;
    spawn_sound(app.clone(), token, preferences, true, "alarm".into());
    Ok(())
}

#[tauri::command]
fn stop_preview_sound(app: tauri::AppHandle) {
    let store = app.state::<AppStore>();
    if store.alert.lock().unwrap_or_else(|p| p.into_inner()).is_none() {
        store.ring_id.fetch_add(1, Ordering::Relaxed);
    }
}

// Keep the active alert and FIFO queue under one consistent lock order.
// A queued alert is promoted atomically when the previous one is dismissed.
fn accept_alert(current: &mut Option<Alert>, pending: &mut VecDeque<Alert>, alert: Alert) -> bool {
    if current.is_some() {
        pending.push_back(alert);
        false
    } else {
        *current = Some(alert);
        true
    }
}

fn advance_alert(current: &mut Option<Alert>, pending: &mut VecDeque<Alert>) -> Option<Alert> {
    *current = pending.pop_front();
    current.clone()
}

#[tauri::command]
fn dismiss_alert(app: tauri::AppHandle) -> Snapshot {
    let store = app.state::<AppStore>();
    store.ring_id.fetch_add(1, Ordering::Relaxed);
    let next = {
        let mut active = store.alert.lock().unwrap_or_else(|p| p.into_inner());
        let mut queue = store.pending_alerts.lock().unwrap_or_else(|p| p.into_inner());
        advance_alert(&mut active, &mut queue)
    };
    if let Some(alert) = next {
        start_alert(&app, &alert);
    }
    let result = snapshot(&store, now_ms());
    let _ = app.emit("angel:state", &result);
    result
}

#[tauri::command]
fn snooze_alert(app: tauri::AppHandle) -> Result<Snapshot, String> {
    let store = app.state::<AppStore>();
    let current = store.alert.lock().unwrap_or_else(|p| p.into_inner()).clone();
    let Some(alert) = current else { return Err("Нет активного сигнала".into()); };
    if alert.kind != "alarm" { return Err("Только будильник можно отложить".into()); }
    // Round up to the next minute: never ring earlier than five minutes later.
    let when = (Local::now() + chrono::Duration::minutes(5) + chrono::Duration::seconds(59))
        .with_second(0).unwrap().with_nanosecond(0).unwrap();
    mutate(&app, |data| {
        if data.alarms.len() >= 32 { return Err("Максимум 32 будильника".into()); }
        data.alarms.push(Alarm {
            id: new_id(), hour: when.hour() as u8, minute: when.minute() as u8,
            label: format!("Повтор: {}", alert.body).chars().take(60).collect(),
            days: vec![], schedule_mode: ScheduleMode::Custom, enabled: true, last_fired_key: None,
        });
        Ok(())
    })?;
    Ok(dismiss_alert(app))
}

fn is_alarm_due(alarm: &Alarm, now: &chrono::DateTime<Local>) -> bool {
    if !alarm.enabled || alarm.hour != now.hour() as u8 || alarm.minute != now.minute() as u8 { return false; }
    alarm.days.is_empty() || alarm.days.contains(&(now.weekday().num_days_from_monday() as u8))
}

// MessageBeep is exported by User32.dll. Declare the stable Win32 ABI directly
// so the alarm tone does not depend on generated windows-sys feature gates.
#[cfg(windows)]
#[link(name = "user32")]
unsafe extern "system" {
    fn MessageBeep(u_type: u32) -> i32;
}

#[cfg(windows)]
fn system_beep() {
    // MB_ICONEXCLAMATION (Windows notification/warning sound).
    unsafe { let _ = MessageBeep(0x0000_0030); }
}
#[cfg(not(windows))]
fn system_beep() {}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

// Keep the player in a Rust worker: it continues playing while WebView2 is hidden.
// The token prevents an old audio thread from continuing after Stop / Snooze.
fn spawn_sound(app: tauri::AppHandle, token: u64, preferences: Preferences, preview: bool, kind: String) {
    thread::spawn(move || {
        let store = app.state::<AppStore>();
        let active = || store.ring_id.load(Ordering::Relaxed) == token;
        if !active() { return; }
        if kind == "timer" || preferences.alarm_melody == "system" {
            for _ in 0..(if preview { 2 } else { 15 }) {
                if !active() { break; }
                system_beep();
                for _ in 0..9 {
                    if !active() { break; }
                    thread::sleep(Duration::from_millis(95));
                }
            }
            return;
        }
        if preferences.alarm_volume == 0 { return; }
        let bytes = if preferences.alarm_melody == "custom" {
            fs::read(store.file.with_file_name("custom_alarm.mp3")).unwrap_or_else(|_| DEFAULT_ALARM_MP3.to_vec())
        } else { DEFAULT_ALARM_MP3.to_vec() };
        let result = (|| -> Result<(), String> {
            let (_stream, handle) = OutputStream::try_default().map_err(|e| e.to_string())?;
            let sink = Sink::try_new(&handle).map_err(|e| e.to_string())?;
            let decoded = Decoder::new(BufReader::new(Cursor::new(bytes))).map_err(|e| e.to_string())?;
            sink.append(decoded.repeat_infinite());
            let target_volume = f32::from(preferences.alarm_volume) / 100.0;
            let fade = Duration::from_secs(u64::from(preferences.fade_in_seconds));
            let started = Instant::now();
            sink.set_volume(if fade.is_zero() { target_volume } else { 0.0 });
            sink.play();
            while active() && (!preview || started.elapsed() < Duration::from_secs(10)) {
                let factor = if fade.is_zero() { 1.0 } else { (started.elapsed().as_secs_f32() / fade.as_secs_f32()).min(1.0) };
                sink.set_volume(target_volume * factor);
                thread::sleep(Duration::from_millis(80));
            }
            sink.stop();
            Ok(())
        })();
        if result.is_err() && active() {
            // If Windows cannot open an audio device or decode the file, retain an audible fallback.
            for _ in 0..(if preview { 2 } else { 15 }) {
                if !active() { break; }
                system_beep();
                thread::sleep(Duration::from_millis(850));
            }
        }
    });
}

fn start_alert(app: &tauri::AppHandle, alert: &Alert) {
    let store = app.state::<AppStore>();
    let token = store.ring_id.fetch_add(1, Ordering::Relaxed) + 1;
    let preferences = store.data.lock().unwrap_or_else(|p| p.into_inner()).preferences.clone();
    let _ = app.emit("angel:state", snapshot(&store, now_ms()));
    if preferences.notifications_enabled {
        let _ = app.notification().builder().title(&alert.title).body(&alert.body).show();
    }
    show_main(app);
    if preferences.sound_enabled {
        spawn_sound(app.clone(), token, preferences, false, alert.kind.clone());
    }
}

fn ring(app: &tauri::AppHandle, alert: Alert) {
    let store = app.state::<AppStore>();
    let start = {
        let mut current = store.alert.lock().unwrap_or_else(|p| p.into_inner());
        let mut queue = store.pending_alerts.lock().unwrap_or_else(|p| p.into_inner());
        accept_alert(&mut current, &mut queue, alert.clone())
    };
    if start { start_alert(app, &alert); }
}

// Evaluate missed alarm minutes as local wall-clock times, preserving each
// existing last_fired_key. The UTC timestamp loop also handles DST boundaries.
// On startup, or if the clock was moved backwards, check only the current minute.
fn due_alarm_key(alarm: &Alarm, now_ms: i64, last_check_ms: Option<i64>) -> Option<String> {
    if !alarm.enabled { return None; }
    let start_ms = match last_check_ms {
        Some(previous) if previous < now_ms => previous.saturating_add(1).max(now_ms.saturating_sub(ALARM_CATCH_UP_MS)),
        _ => now_ms,
    };
    let first_minute = start_ms.div_euclid(60_000);
    let last_minute = now_ms.div_euclid(60_000);
    let mut candidate = None;
    for minute in first_minute..=last_minute {
        let Some(instant) = Local.timestamp_millis_opt(minute.saturating_mul(60_000)).single() else { continue; };
        if is_alarm_due(alarm, &instant) {
            let key = instant.format("%Y-%m-%d %H:%M").to_string();
            if alarm.last_fired_key.as_deref() != Some(key.as_str()) {
                candidate = Some(key);
            }
        }
    }
    candidate
}

// Pure state transition: test without an audio device or a Tauri window.
fn collect_due_events(data: &mut Persisted, now: &chrono::DateTime<Local>, last_check_ms: Option<i64>) -> Vec<Alert> {
    let now_millis = now.timestamp_millis();
    let mut fired = Vec::new();
    if data.timer.running && remaining_timer_ms(&data.timer, now_millis) == 0 {
        data.timer.running = false;
        data.timer.deadline_ms = None;
        data.timer.remaining_ms = 0;
        fired.push(Alert {kind:"timer".into(), title:"Таймер завершён".into(), body:"Время вышло!".into()});
    }
    for extra in &mut data.extra_timers {
        if extra.timer.running && remaining_timer_ms(&extra.timer, now_millis) == 0 {
            extra.timer.running = false;
            extra.timer.deadline_ms = None;
            extra.timer.remaining_ms = 0;
            fired.push(Alert {kind:"timer".into(), title:"Таймер завершён".into(), body:extra.title.clone()});
        }
    }
    for alarm in &mut data.alarms {
        if let Some(key) = due_alarm_key(alarm, now_millis, last_check_ms) {
            alarm.last_fired_key = Some(key);
            if alarm.days.is_empty() { alarm.enabled = false; }
            fired.push(Alert {kind:"alarm".into(), title:"Будильник".into(), body:alarm.label.clone()});
        }
    }
    fired
}

fn window_needs_updates(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main")
        .map(|window| window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false))
        .unwrap_or(false)
}

fn tick(app: &tauri::AppHandle, last_check_ms: Option<i64>) -> (Duration, i64) {
    let store = app.state::<AppStore>();
    let now = Local::now();
    let now_millis = now.timestamp_millis();
    let delay;
    let fired;
    let changed;
    {
        let mut data = store.data.lock().unwrap_or_else(|p| p.into_inner());
        fired = collect_due_events(&mut data, &now, last_check_ms);
        changed = !fired.is_empty();
        if changed {
            if let Err(err) = save(&store.file, &*data) { eprintln!("AngelTime: ошибка сохранения: {err}"); }
        }
        // In the tray, render no WebView frames and perform fewer backend ticks.
        // Event deadlines remain absolute, so sleeping doesn't accumulate drift.
        let visible = window_needs_updates(app);
        delay = if visible && data.stopwatch.started_at_ms.is_some() {
            Duration::from_millis(100)
        } else if data.timer.running || data.extra_timers.iter().any(|entry| entry.timer.running) {
            Duration::from_millis(if visible { 200 } else { 500 })
        } else if visible {
            Duration::from_millis(500)
        } else {
            Duration::from_millis(1000)
        };
    }
    for alert in fired { ring(app, alert); }
    // Update visible counters, but don't send snapshots to a hidden WebView.
    let visible = window_needs_updates(app);
    if visible || changed {
        let _ = app.emit("angel:state", snapshot(&store, now_millis));
    }
    (delay, now_millis)
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let file = dir.join("state.json");
            app.manage(AppStore {
                data: Mutex::new(load(&file)), alert: Mutex::new(None), pending_alerts: Mutex::new(VecDeque::new()), file,
                ring_id: AtomicU64::new(0),
            });
            let show = MenuItem::with_id(app, "show", "Открыть AngelTime", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("Не найдена иконка приложения")?.clone())
                .tooltip("AngelTime — будильник, таймер, секундомер")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) {
                        show_main(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => show_main(app),
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;
            let handle = app.handle().clone();
            thread::spawn(move || {
                let mut last_check_ms = None;
                loop {
                    let (delay, checked_at) = tick(&handle, last_check_ms);
                    last_check_ms = Some(checked_at);
                    thread::sleep(delay);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state, upsert_alarm, delete_alarm, toggle_alarm, set_work_days,
            timer_start, timer_pause, timer_resume, timer_reset,
            extra_timer_add, extra_timer_action,
            stopwatch_toggle, stopwatch_lap, stopwatch_reset,
            dismiss_alert, snooze_alert, set_preferences, preview_sound, stop_preview_sound, import_alarm_audio,
            backup_export, backup_preview, backup_status, backup_import, backup_undo
        ])
        .run(tauri::generate_context!())
        .expect("Не удалось запустить AngelTime");
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn backup_roundtrip_only_contains_alarms_and_preferences() {
        let mut data = Persisted::default();
        data.alarms.push(Alarm {
            id: "internal-id".into(), hour: 7, minute: 45, label: "Утро".into(),
            days: vec![0, 2, 4], schedule_mode: ScheduleMode::Custom,
            enabled: true, last_fired_key: Some("2026-10-31 07:45".into()),
        });
        data.timer.running = true;
        data.stopwatch.elapsed_ms = 99_000;
        let json = serde_json::to_string(&make_backup(&data)).unwrap();
        assert!(!json.contains("internal-id"));
        assert!(!json.contains("last_fired_key"));
        assert!(!json.contains("stopwatch"));
        assert!(!json.contains("deadline_ms"));
        let imported = validated_backup(&json).unwrap();
        assert_eq!(imported.alarms.len(), 1);
        assert_eq!(imported.alarms[0].label, "Утро");
    }

    #[test]
    fn backup_rejects_wrong_schema_and_bad_alarm() {
        let data = Persisted::default();
        let mut doc = make_backup(&data);
        doc.schema_version = 999;
        assert!(validated_backup(&serde_json::to_string(&doc).unwrap()).is_err());
        doc.schema_version = BACKUP_SCHEMA;
        doc.alarms.push(BackupAlarm { hour: 26, minute: 0, label: "X".into(),
            days: vec![], schedule_mode: ScheduleMode::Custom, enabled: true });
        assert!(validated_backup(&serde_json::to_string(&doc).unwrap()).is_err());
    }

    #[test]
    fn backup_rejects_invalid_workweek_and_oversized_payload() {
        let data = Persisted::default();
        let mut doc = make_backup(&data);
        doc.preferences.work_days = vec![0,1,2,3,4,5,6];
        assert!(validated_backup(&serde_json::to_string(&doc).unwrap()).is_err());
        assert!(validated_backup(&"x".repeat(BACKUP_MAX_BYTES + 1)).is_err());
    }

    #[test]
    fn workday_schedules_follow_user_configuration() {
        let mon_to_fri = vec![0,1,2,3,4];
        assert_eq!(scheduled_days(ScheduleMode::Workdays, &[], &mon_to_fri), mon_to_fri);
        assert_eq!(scheduled_days(ScheduleMode::Weekends, &[], &mon_to_fri), vec![5,6]);
        let shifts = vec![1,3,5];
        assert_eq!(scheduled_days(ScheduleMode::Workdays, &[0,4], &shifts), shifts);
        assert_eq!(scheduled_days(ScheduleMode::Weekends, &[], &shifts), vec![0,2,4,6]);
        assert_eq!(scheduled_days(ScheduleMode::Custom, &[6,2,2], &shifts), vec![2,6]);
    }

    #[test]
    fn legacy_alarm_remains_custom_with_same_days() {
        let alarm: Alarm = serde_json::from_str(r#"{"id":"old","hour":9,"minute":30,"label":"Смена","days":[2,4],"enabled":true}"#).unwrap();
        assert_eq!(alarm.schedule_mode, ScheduleMode::Custom);
        assert_eq!(alarm.days, vec![2,4]);
        let prefs: Preferences = serde_json::from_str(r#"{"sound_enabled":true}"#).unwrap();
        assert_eq!(prefs.work_days, vec![0,1,2,3,4]);
    }

    #[test]
    fn recent_alarm_is_caught_up_once_after_sleep() {
        let due = Local.with_ymd_and_hms(2026, 10, 22, 8, 30, 0).single().unwrap();
        let now = due + chrono::Duration::minutes(3);
        let mut data = Persisted::default();
        data.alarms.push(Alarm { hour: 8, minute: 30, label: "Утро".into(), ..Alarm::default() });
        let previous = due.timestamp_millis() - 30_000;
        let first = collect_due_events(&mut data, &now, Some(previous));
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].body, "Утро");
        assert!(!data.alarms[0].enabled); // One-shot stays disabled.
        assert!(collect_due_events(&mut data, &now, Some(previous)).is_empty());
    }

    #[test]
    fn alarm_older_than_catch_up_limit_is_not_replayed() {
        let due = Local.with_ymd_and_hms(2026, 10, 22, 8, 30, 0).single().unwrap();
        let now = due + chrono::Duration::minutes(12);
        let alarm = Alarm { hour: 8, minute: 30, ..Alarm::default() };
        assert_eq!(due_alarm_key(&alarm, now.timestamp_millis(), Some(due.timestamp_millis()-30_000)), None);
    }

    #[test]
    fn current_minute_alarms_fire_without_prior_poll() {
        let now = Local.with_ymd_and_hms(2026, 10, 22, 8, 30, 25).single().unwrap();
        let alarm = Alarm { hour: 8, minute: 30, ..Alarm::default() };
        assert!(due_alarm_key(&alarm, now.timestamp_millis(), None).is_some());
    }

    #[test]
    fn repeated_alarm_is_not_replayed_on_clock_rollback() {
        let now = Local.with_ymd_and_hms(2026, 10, 22, 8, 30, 25).single().unwrap();
        let fired_key = now.format("%Y-%m-%d %H:%M").to_string();
        let alarm = Alarm { hour: 8, minute: 30, days: vec![now.weekday().num_days_from_monday() as u8],
            last_fired_key: Some(fired_key), ..Alarm::default() };
        // A rollback is not interpreted as an enormous forward catch-up.
        assert_eq!(due_alarm_key(&alarm, now.timestamp_millis(), Some(now.timestamp_millis() + 120_000)), None);
    }

    #[test]
    fn simultaneous_timers_complete_once_and_keep_order() {
        let now = Local.with_ymd_and_hms(2026, 10, 22, 8, 30, 0).single().unwrap();
        let past = now.timestamp_millis() - 10;
        let mut data = Persisted::default();
        data.timer.running = true;
        data.timer.deadline_ms = Some(past);
        for title in ["Чай", "Кофе"] {
            data.extra_timers.push(ExtraTimer { id: title.into(), title: title.into(),
                timer: TimerData { duration_seconds: 30, remaining_ms: 30_000, deadline_ms: Some(past), running: true } });
        }
        let events = collect_due_events(&mut data, &now, None);
        assert_eq!(events.len(), 3);
        assert_eq!(events.iter().map(|e| e.body.as_str()).collect::<Vec<_>>(), ["Время вышло!", "Чай", "Кофе"]);
        assert!(collect_due_events(&mut data, &now, None).is_empty());
    }

    #[test]
    fn alert_queue_is_fifo_and_advance_is_atomic() {
        let alert = |name: &str| Alert { kind: "timer".into(), title: "Таймер".into(), body: name.into() };
        let mut current = None;
        let mut pending = VecDeque::new();
        assert!(accept_alert(&mut current, &mut pending, alert("первый")));
        assert!(!accept_alert(&mut current, &mut pending, alert("второй")));
        assert!(!accept_alert(&mut current, &mut pending, alert("третий")));
        assert_eq!(current.as_ref().unwrap().body, "первый");
        assert_eq!(advance_alert(&mut current, &mut pending).unwrap().body, "второй");
        assert_eq!(advance_alert(&mut current, &mut pending).unwrap().body, "третий");
        assert!(advance_alert(&mut current, &mut pending).is_none());
        assert!(pending.is_empty());
    }

    #[test]
    fn repeat_alarm_last_fired_key_survives_serialization() {
        let mut data = Persisted::default();
        data.alarms.push(Alarm { days: vec![3], last_fired_key: Some("2026-10-22 08:30".into()), ..Alarm::default() });
        let serialized = serde_json::to_string(&data).unwrap();
        let reloaded: Persisted = serde_json::from_str(&serialized).unwrap();
        assert_eq!(reloaded.alarms[0].last_fired_key.as_deref(), Some("2026-10-22 08:30"));
        assert_eq!(reloaded.preferences.alarm_melody, "default");
    }

    #[test]
    fn timer_counts_down_and_pauses() {
        let timer = TimerData { duration_seconds: 10, remaining_ms: 10_000, deadline_ms: Some(11_000), running: true };
        assert_eq!(remaining_timer_ms(&timer, 4_000), 7_000);
        assert_eq!(remaining_timer_ms(&timer, 11_000), 0);
        // Regression: an expired deadline previously wrapped -1000 to u64::MAX - 999.
        assert_eq!(remaining_timer_ms(&timer, 12_000), 0);
        assert_eq!(remaining_timer_ms(&timer, 15_000), 0);
    }

    #[test]
    fn paused_timer_keeps_remaining_ms() {
        let timer = TimerData { duration_seconds: 10, remaining_ms: 3_400, deadline_ms: None, running: false };
        assert_eq!(remaining_timer_ms(&timer, 999_999), 3_400);
    }

    #[test]
    fn running_timer_without_deadline_does_not_wrap() {
        let timer = TimerData { duration_seconds: 10, remaining_ms: 10_000, deadline_ms: None, running: true };
        assert_eq!(remaining_timer_ms(&timer, 12_000), 0);
    }

    #[test]
    fn stopwatch_adds_elapsed_live_time() {
        let sw = StopwatchData { elapsed_ms: 5_000, started_at_ms: Some(20_000), laps: vec![] };
        assert_eq!(stopwatch_elapsed_ms(&sw, 22_500), 7_500);
    }

    #[test]
    fn stopwatch_clock_rollback_does_not_overflow() {
        let sw = StopwatchData { elapsed_ms: 5_000, started_at_ms: Some(20_000), laps: vec![] };
        // Regression: system time moving backward must not produce a huge u64.
        assert_eq!(stopwatch_elapsed_ms(&sw, 19_000), 5_000);
        assert_eq!(stopwatch_elapsed_ms(&sw, 20_000), 5_000);
    }

    #[test]
    fn repeating_alarm_respects_day_of_week() {
        let monday = Local.with_ymd_and_hms(2026, 10, 19, 8, 30, 0).single().unwrap();
        let mut alarm = Alarm { hour: 8, minute: 30, days: vec![0], ..Alarm::default() };
        assert!(is_alarm_due(&alarm, &monday));
        alarm.days = vec![1];
        assert!(!is_alarm_due(&alarm, &monday));
    }
    #[test]
    fn legacy_state_defaults_to_audible_alerts() {
        let data: Persisted = serde_json::from_str(r#"{"alarms":[],"timer":{"duration_seconds":300},"stopwatch":{}}"#).unwrap();
        assert!(data.preferences.sound_enabled);
        assert!(data.preferences.notifications_enabled);
        assert!(!data.preferences.reduced_motion);
    }

    #[test]
    fn saved_preferences_roundtrip() {
        let mut data = Persisted::default();
        data.preferences.sound_enabled = false;
        data.preferences.notifications_enabled = false;
        data.preferences.reduced_motion = true;
        let stored = serde_json::to_string(&data).unwrap();
        let restored: Persisted = serde_json::from_str(&stored).unwrap();
        assert!(!restored.preferences.sound_enabled);
        assert!(!restored.preferences.notifications_enabled);
        assert!(restored.preferences.reduced_motion);
    }
    #[test]
    fn legacy_data_gets_default_song_without_losing_timer() {
        let data: Persisted = serde_json::from_str(r#"{"alarms":[],"timer":{"duration_seconds":120,"remaining_ms":120000},"stopwatch":{}}"#).unwrap();
        assert_eq!(data.timer.duration_seconds, 120);
        assert!(data.extra_timers.is_empty());
        assert_eq!(data.preferences.alarm_melody, "default");
        assert_eq!(data.preferences.alarm_volume, 75);
        assert_eq!(data.preferences.fade_in_seconds, 5);
    }
    #[test]
    fn extra_timers_are_independent() {
        let mut data = Persisted::default();
        data.extra_timers.push(ExtraTimer {id:"first".into(), title:"Кофе".into(),
            timer: TimerData {duration_seconds:90, remaining_ms:90_000, deadline_ms:Some(100_000), running:true}});
        data.extra_timers.push(ExtraTimer {id:"second".into(), title:"Чай".into(),
            timer: TimerData {duration_seconds:120, remaining_ms:120_000, deadline_ms:None, running:false}});
        let a = remaining_timer_ms(&find_extra_mut(&mut data,"first").unwrap().timer, 40_000);
        let b = remaining_timer_ms(&find_extra_mut(&mut data,"second").unwrap().timer, 40_000);
        assert_eq!(a,60_000); assert_eq!(b,120_000);
        assert_eq!(data.timer.duration_seconds,300);
    }
    #[test]
    fn rejects_invalid_audio_preferences() {
        let mut p = Preferences::default();
        p.alarm_melody = "unknown".into();
        assert!(validate_preferences(&p).is_err());
        p.alarm_melody = "default".into();
        p.alarm_volume = 101;
        assert!(validate_preferences(&p).is_err());
        p.alarm_volume = 75;
        p.fade_in_seconds = 31;
        assert!(validate_preferences(&p).is_err());
    }
    #[test]
    fn recognizes_mp3_headers() {
        assert!(looks_like_mp3(b"ID3\x04\x00\x00"));
        assert!(looks_like_mp3(&[0xff,0xfb,0x90,0x64]));
        assert!(!looks_like_mp3(b"not audio"));
    }

}
