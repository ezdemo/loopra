package connector

import (
	"strings"
	"testing"
)

func TestBuiltinCatalogLoadsAndValidates(t *testing.T) {
	catalog, err := LoadCatalog()
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Connectors) == 0 || len(catalog.Categories) == 0 {
		t.Fatal("empty catalog")
	}
	if _, ok := catalog.Find("github"); !ok {
		t.Fatal("github connector missing")
	}
}

func TestValidateRejectsUndeclaredPlaceholder(t *testing.T) {
	catalog := Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{{
			ID: "x", Category: "dev",
			Transport: Transport{Type: "streamable", URL: "https://x/mcp?key={{token}}"},
			Auth:      Auth{Type: "token", Fields: []Field{{Key: "other"}}},
		}},
	}
	err := catalog.Validate()
	if err == nil || !strings.Contains(err.Error(), "{{token}}") {
		t.Fatalf("want placeholder error, got %v", err)
	}
}

func TestValidateRejectsDuplicateID(t *testing.T) {
	conn := Connector{
		ID: "dup", Category: "dev",
		Transport: Transport{Type: "streamable", URL: "https://x/mcp"},
		Auth:      Auth{Type: "oauth"},
	}
	catalog := Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{conn, conn},
	}
	if err := catalog.Validate(); err == nil || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("want duplicate error, got %v", err)
	}
}

func TestValidateOAuthUserClientRequiresClientFields(t *testing.T) {
	catalog := Catalog{
		Categories: []Category{{ID: "dev", Name: "开发"}},
		Connectors: []Connector{{
			ID: "x", Category: "dev",
			Transport: Transport{Type: "streamable", URL: "https://x/mcp"},
			Auth:      Auth{Type: "oauth", Client: "user"},
		}},
	}
	if err := catalog.Validate(); err == nil {
		t.Fatal("want error for missing clientId/clientSecret")
	}
}
