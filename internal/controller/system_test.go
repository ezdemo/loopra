package controller

import (
	"reflect"
	"testing"
)

func TestDesktopApplicationsByPlatform(t *testing.T) {
	for _, test := range []struct {
		name      string
		goos      string
		installed []string
		want      []string
	}{
		{"mac", "darwin", []string{"zsh", "bash"}, []string{"folder", "zsh", "bash", "terminal"}},
		{"mac without bash", "darwin", []string{"zsh"}, []string{"folder", "zsh", "terminal"}},
		{"mac with powershell", "darwin", []string{"pwsh", "zsh", "bash"}, []string{"folder", "powershell", "zsh", "bash", "terminal"}},
		{"windows", "windows", []string{"powershell.exe", "git-bash.exe"}, []string{"folder", "powershell", "terminal", "git-bash", "bash"}},
		{"linux", "linux", []string{"bash", "gnome-terminal"}, []string{"folder", "bash", "terminal"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := desktopApplicationsFor(test.goos, func(name string) string {
				for _, installed := range test.installed {
					if name == installed {
						return "resolved/" + name
					}
				}
				return ""
			})
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("applications = %v, want %v", got, test.want)
			}
		})
	}
}

func TestMacDesktopShellCommand(t *testing.T) {
	workspace := "/tmp/project with spaces and 'quotes'"
	for _, test := range []struct{ application, shell string }{
		{"terminal", "zsh"}, {"zsh", "zsh"}, {"bash", "bash"}, {"powershell", "pwsh"},
	} {
		t.Run(test.application, func(t *testing.T) {
			cmd, err := desktopCommandFor("darwin", workspace, test.application)
			if err != nil {
				t.Fatal(err)
			}
			if cmd.Args[0] != "osascript" || cmd.Args[1] != "-e" {
				t.Fatalf("expected Terminal AppleScript, got %v", cmd.Args)
			}
			if got := cmd.Args[3:]; !reflect.DeepEqual(got, []string{workspace, test.shell}) {
				t.Fatalf("launch arguments = %v", got)
			}
		})
	}
}
