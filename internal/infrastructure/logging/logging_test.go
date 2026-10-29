package logging

import (
	"bytes"
	"context"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gogf/gf/v2/os/glog"
)

func TestFormatLineMatchesSpringColumns(t *testing.T) {
	now := time.Date(2026, 10, 29, 9, 13, 5, 0, time.UTC)
	line := formatLine(now, glog.LEVEL_INFO, 18828, 165, "main", "http", "GET /api/health 200", false)
	want := strings.Join([]string{
		"2026-10-29 09:13:05.000",
		" INFO",
		"18828",
		"---",
		"[main]",
		"http  ",
		" 165",
		": GET /api/health 200",
	}, " ")
	if line != want {
		t.Fatalf("line=%q\nwant=%q", line, want)
	}
	warn := formatLine(now, glog.LEVEL_WARN, 18828, 12, "main", "server", "shutting down", false)
	if !strings.Contains(warn, " WARN 18828 --- [main] server") {
		t.Fatalf("warn=%q", warn)
	}
	if !strings.HasSuffix(warn, "  12 : shutting down") {
		t.Fatalf("warn=%q", warn)
	}
}

func TestFormatLineColorsEachField(t *testing.T) {
	now := time.Date(2026, 10, 29, 10, 13, 56, 258000000, time.UTC)
	line := formatLine(now, glog.LEVEL_ERRO, 18828, 165, "main", "chat", "turn failed", true)

	checks := []string{
		ansiFaint + "2026-10-29 10:13:56.258" + ansiReset,
		ansiRed + "ERROR" + ansiReset,
		ansiMagenta + "18828" + ansiReset,
		ansiFaint + "---" + ansiReset,
		ansiFaint + "[main]" + ansiReset,
		ansiCyan + "chat  " + ansiReset,
		ansiFaint + ":" + ansiReset,
	}
	for _, piece := range checks {
		if !strings.Contains(line, piece) {
			t.Fatalf("missing %q in %q", piece, line)
		}
	}
	if !strings.HasSuffix(line, ansiReset+" turn failed") {
		t.Fatalf("message should stay uncolored: %q", line)
	}
	info := formatLine(now, glog.LEVEL_INFO, 1, 1, "main", "server", "up", true)
	if !strings.Contains(info, ansiGreen+" INFO"+ansiReset) {
		t.Fatalf("info=%q", info)
	}
	debug := formatLine(now, glog.LEVEL_DEBU, 1, 1, "main", "acp", "detail", true)
	if !strings.Contains(debug, ansiGreen+"DEBUG"+ansiReset) {
		t.Fatalf("debug=%q", debug)
	}
	warn := formatLine(now, glog.LEVEL_WARN, 1, 1, "main", "acp", "careful", true)
	if !strings.Contains(warn, ansiYellow+" WARN"+ansiReset) {
		t.Fatalf("warn=%q", warn)
	}
}

func TestFormatLineKeepsLongNames(t *testing.T) {
	now := time.Date(2026, 10, 29, 9, 13, 5, 0, time.UTC)
	thread := strings.Repeat("t", 20)
	loggerName := strings.Repeat("L", 12)
	line := formatLine(now, glog.LEVEL_INFO, 1, 100000, thread, loggerName, "ok", false)
	if !strings.Contains(line, "["+thread+"]") {
		t.Fatalf("thread=%q", line)
	}
	if !strings.Contains(line, loggerName+" ") {
		t.Fatalf("logger=%q", line)
	}
	if !strings.Contains(line, "100000 : ok") {
		t.Fatalf("line number should stay intact: %q", line)
	}
}

func TestSplitTag(t *testing.T) {
	tag, text := splitTag("[acp] started pid=1")
	if tag != "acp" || text != "started pid=1" {
		t.Fatalf("tag=%q text=%q", tag, text)
	}
	tag, text = splitTag("no tag here")
	if tag != "" || text != "no tag here" {
		t.Fatalf("tag=%q text=%q", tag, text)
	}
}

func TestRenderDropsGoFrameHeader(t *testing.T) {
	var buf bytes.Buffer
	logger := glog.New()
	logger.SetStdoutPrint(false)
	logger.SetWriter(&buf)
	logger.SetHeaderPrint(false)
	logger.SetFlags(0)
	logger.SetStack(false)
	logger.SetHandlers(render)
	if err := logger.SetLevelStr("INFO"); err != nil {
		t.Fatal(err)
	}
	colors = false
	logger.Infof(context.WithValue(context.Background(), callSiteKey{}, 165), "[server] hello")
	got := buf.String()
	if strings.Contains(got, "[INFO]") {
		t.Fatalf("framework header leaked: %q", got)
	}
	if !strings.Contains(got, " INFO ") || !strings.Contains(got, " --- ") || !strings.Contains(got, "server") {
		t.Fatalf("got %q", got)
	}
	if !strings.HasSuffix(got, " 165 : hello\n") {
		t.Fatalf("got %q", got)
	}
}

func TestCallLinePointsAtCaller(t *testing.T) {
	_, _, here, _ := runtime.Caller(0)
	got := callLine(1) // 必须紧跟上一行
	if got != here+1 {
		t.Fatalf("call line=%d want %d", got, here+1)
	}
}

func TestCallSiteSkipReachesUser(t *testing.T) {
	_, _, here, _ := runtime.Caller(0)
	got := callSiteOuter() // 必须紧跟上一行
	if got != here+1 {
		t.Fatalf("call line=%d want %d", got, here+1)
	}
}

func callSiteOuter() int { return callSiteMid() }

func callSiteMid() int { return callLine(callSiteSkip) }

func TestCurrentGIDPositive(t *testing.T) {
	if currentGID() == 0 {
		t.Fatal("expected a goroutine id")
	}
	name := threadName()
	if name != "main" && !strings.HasPrefix(name, "g") {
		t.Fatalf("thread=%q", name)
	}
}

func TestDetectColorHonorsNoColor(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	t.Setenv("FORCE_COLOR", "1")
	if detectColor() {
		t.Fatal("NO_COLOR should win")
	}
}

func TestPrintLineIsPlainAndSilenceDropsIt(t *testing.T) {
	previous := lineOut
	wasSilent := silenced
	t.Cleanup(func() {
		lineOut = previous
		silenced = wasSilent
	})
	var buf bytes.Buffer
	lineOut = &buf
	silenced = false
	PrintLine("[Web Interface]:  http://127.0.0.1:1/index.html?rk=key")
	if buf.String() != "[Web Interface]:  http://127.0.0.1:1/index.html?rk=key\n" {
		t.Fatalf("line=%q", buf.String())
	}
	silenced = true
	PrintLine("hidden")
	if strings.Count(buf.String(), "\n") != 1 {
		t.Fatalf("silence leaked %q", buf.String())
	}
}

func TestOnlyTagsKeepsACPAndSilenceDropsTheRest(t *testing.T) {
	t.Cleanup(func() {
		tagFilter = nil
		logger()
		instance.SetStdoutPrint(true)
		instance.SetWriter(os.Stdout)
		glog.SetStdoutPrint(true)
		glog.SetWriter(os.Stdout)
	})
	var buf bytes.Buffer
	UseWriter(&buf)
	OnlyTags("acp")
	Infof("chat", "turn start")
	Infof("acp", "started")
	got := buf.String()
	if strings.Contains(got, "turn start") || !strings.Contains(got, "started") {
		t.Fatalf("filtered log=%q", got)
	}
	buf.Reset()
	Silence()
	Infof("acp", "hidden")
	if buf.Len() != 0 {
		t.Fatalf("silence leaked %q", buf.String())
	}
}

func TestDetectColorOnByDefault(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	t.Setenv("TERM", "")
	t.Setenv("FORCE_COLOR", "")
	t.Setenv("CLICOLOR", "")
	if !detectColor() {
		t.Fatal("color should stay on when stdout is not a terminal")
	}
}
