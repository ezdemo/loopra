package connector

import (
	"encoding/json"
	"io/fs"
	"os"
	"testing"

	connectordata "github.com/ezdemo/looprax/connectors"
	"github.com/google/jsonschema-go/jsonschema"
)

func TestRegistryDescriptorsMatchSchema(t *testing.T) {
	data, err := os.ReadFile("../../../connectors/schema/connector.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	var schema jsonschema.Schema
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		t.Fatal(err)
	}
	err = fs.WalkDir(connectordata.FS, "registry", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		raw, err := connectordata.FS.ReadFile(path)
		if err != nil {
			return err
		}
		var instance any
		if err := json.Unmarshal(raw, &instance); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if err := resolved.Validate(instance); err != nil {
			t.Errorf("%s: %v", path, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
