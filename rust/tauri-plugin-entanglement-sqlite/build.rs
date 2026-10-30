const COMMANDS: &[&str] = &[
    "select",
    "execute",
    "begin",
    "commit",
    "rollback",
    "data_version",
    "close",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
