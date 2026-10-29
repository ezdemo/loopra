//go:build windows

package controller

import (
	"os/exec"

	"github.com/ezdemo/looprax/internal/infrastructure/hideconsole"
)

func hideProcess(cmd *exec.Cmd) { hideconsole.Apply(cmd) }
