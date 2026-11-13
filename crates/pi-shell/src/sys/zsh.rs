//! Installed system zsh function directories shared by the process shell and
//! its integration fixtures. No shell process is invoked during discovery.

use std::path::{Path, PathBuf};

/// Installed directories of zsh 5.9's shell-code completion functions.
///
/// These contain `_main_complete`, `compinit`, etc. in one flat directory
/// (macOS, `/usr/share/zsh/5.9/functions`) or the source-tree layout
/// (Debian, `/usr/share/zsh/functions/Completion/Base`, ...). `None` when
/// neither installation layout exists.
#[must_use]
pub fn function_dirs() -> Option<Vec<PathBuf>> {
	for root in ["/usr/share/zsh/5.9/functions", "/usr/share/zsh/functions"] {
		let root = Path::new(root);
		if root.join("_main_complete").is_file() && root.join("compinit").is_file() {
			return Some(vec![root.to_owned()]);
		}
		if root.join("Completion/Base/_main_complete").is_file() {
			let mut dirs = Vec::new();
			for top in sorted_dirs(root) {
				dirs.extend(sorted_dirs(&top));
				dirs.push(top);
			}
			return Some(dirs);
		}
	}
	None
}

fn sorted_dirs(dir: &Path) -> Vec<PathBuf> {
	let mut dirs: Vec<PathBuf> = std::fs::read_dir(dir)
		.into_iter()
		.flatten()
		.flatten()
		.map(|e| e.path())
		.filter(|p| p.is_dir())
		.collect();
	dirs.sort();
	dirs
}
