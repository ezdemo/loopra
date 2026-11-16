package connectors

import "embed"

//go:embed catalog.json registry/*.json
var FS embed.FS
