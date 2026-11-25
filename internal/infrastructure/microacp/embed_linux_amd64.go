//go:build linux && !android && amd64

package microacp

import _ "embed"

//go:embed assets/linux_amd64/micro-acp.gz
var payload []byte
