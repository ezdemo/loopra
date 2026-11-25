//go:build linux && !android && arm64

package microacp

import _ "embed"

//go:embed assets/linux_arm64/micro-acp.gz
var payload []byte
