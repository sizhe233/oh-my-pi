// A container's PID 1 may never reap orphaned grandchildren. Adopt them in
// this test process so the unchanged disappearance assertion can observe an
// actually reaped process rather than mistaking a zombie for a live command.
#[cfg(target_os = "linux")]
pub struct ChildReaper(i32);

#[cfg(target_os = "linux")]
impl ChildReaper {
	pub fn new() -> Self {
		let mut previous = 0;
		// SAFETY: GET writes one initialized integer; SET affects this process.
		unsafe {
			assert_eq!(libc::prctl(libc::PR_GET_CHILD_SUBREAPER, &raw mut previous), 0);
			assert_eq!(libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1), 0);
		}
		Self(previous)
	}
}

#[cfg(target_os = "linux")]
impl Drop for ChildReaper {
	fn drop(&mut self) {
		// SAFETY: restore this process's previous subreaper setting.
		unsafe {
			libc::prctl(libc::PR_SET_CHILD_SUBREAPER, self.0);
		}
	}
}

pub fn alive(pid: i32) -> bool {
	#[cfg(target_os = "linux")]
	// SAFETY: only reap this exact PID if it is our already-exited child;
	// WNOHANG cannot terminate or block on a still-running process.
	unsafe {
		libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG);
	}

	// SAFETY: signal 0 only probes existence.
	unsafe { libc::kill(pid, 0) == 0 }
}
