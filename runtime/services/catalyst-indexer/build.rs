use std::process::Command;

// Names the repository commit this runtime is built from; a host can set VELON_REVISION instead.
fn main() {
    println!("cargo:rerun-if-env-changed=VELON_REVISION");
    let revision = std::env::var("VELON_REVISION").unwrap_or_else(|_| {
        let git = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        };
        if let Some(head) = git(&["rev-parse", "--git-path", "HEAD"]) {
            println!("cargo:rerun-if-changed={head}");
        }
        if let Some(index) = git(&["rev-parse", "--git-path", "index"]) {
            println!("cargo:rerun-if-changed={index}");
        }
        let commit = git(&["rev-parse", "HEAD"]).unwrap_or_else(|| "unknown".into());
        let dirty = git(&[
            "status",
            "--porcelain",
            "--",
            "../../../sdk",
            "../../../arm",
        ])
        .is_some_and(|status| !status.is_empty());
        if dirty {
            format!("{commit}-dirty")
        } else {
            commit
        }
    });
    println!("cargo:rustc-env=VELON_REVISION={revision}");
}
