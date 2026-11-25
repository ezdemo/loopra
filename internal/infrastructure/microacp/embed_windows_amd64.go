//go:build windows && amd64

package microacp

import _ "embed"

//go:embed assets/windows_amd64/micro-acp.gz
var payload []byte
