//go:build darwin && !ios && amd64

package microacp

import _ "embed"

//go:embed assets/darwin_amd64/micro-acp.gz
var payload []byte
