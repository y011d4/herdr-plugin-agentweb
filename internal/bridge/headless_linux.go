package bridge

import "syscall"

// childSysProcAttr puts a headless child in its own process group (so a stop reaches what
// it started too) and kills it when the bridge dies without a shutdown (a crash, SIGKILL).
func childSysProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
}
