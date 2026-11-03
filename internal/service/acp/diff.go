package acp

import "github.com/ezdemo/looprax/internal/infrastructure/filediff"

type FileChange = filediff.FileChange

func CompareFile(path string, oldText *string, newText string) FileChange {
	return filediff.CompareFile(path, oldText, newText)
}
