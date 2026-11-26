//go:build !linux

package bridge

import "syscall"

// childSysProcAttr: no Pdeathsig outside Linux, so only the shutdown ends a headless child.
func childSysProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
