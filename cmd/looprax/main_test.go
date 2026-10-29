package main

import (
	"bytes"
	"errors"
	"testing"
)

func TestParseArgsDefaultsToWeb(t *testing.T) {
	parsed, err := parseArgs(nil, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Command != commandWeb || parsed.Options.Port != "" {
		t.Fatalf("parsed = %+v", parsed)
	}

	parsed, err = parseArgs([]string{"web"}, &bytes.Buffer{})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Command != commandWeb || parsed.Options.Port != "" {
		t.Fatalf("web parsed = %+v", parsed)
	}
}

func TestParseArgsACP(t *testing.T) {
	for _, args := range [][]string{{"acp"}, {"--home", "data", "acp"}} {
		parsed, err := parseArgs(args, &bytes.Buffer{})
		if err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if parsed.Command != commandACP {
			t.Fatalf("%v command = %q", args, parsed.Command)
		}
	}
	if _, err := parseArgs([]string{"acp", "4567"}, &bytes.Buffer{}); !errors.Is(err, errUsage) {
		t.Fatalf("acp with port err = %v", err)
	}
}

func TestParseArgsAcceptsPortForms(t *testing.T) {
	cases := [][]string{
		{"4567"},
		{"web", "4567"},
		{"--port", "4567"},
		{"web", "--port", "4567"},
		{"--port", "4567", "web"},
	}
	for _, args := range cases {
		parsed, err := parseArgs(args, &bytes.Buffer{})
		if err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		if parsed.Command != commandWeb || parsed.Options.Port != "4567" {
			t.Fatalf("%v parsed = %+v", args, parsed)
		}
	}
}

func TestParseArgsRejectsExtraPositionals(t *testing.T) {
	var output bytes.Buffer
	_, err := parseArgs([]string{"4567", "extra"}, &output)
	if !errors.Is(err, errUsage) {
		t.Fatalf("err = %v", err)
	}
	if output.Len() == 0 {
		t.Fatal("usage was not printed")
	}
}
