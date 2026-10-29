//go:build !windows

package controller

import "os/exec"

func hideProcess(cmd *exec.Cmd) {}
