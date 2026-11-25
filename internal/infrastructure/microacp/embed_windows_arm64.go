//go:build windows && arm64

package microacp

import _ "embed"

//go:embed assets/windows_arm64/micro-acp.gz
var payload []byte
