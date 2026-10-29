package tools

import (
	"strings"

	"golang.org/x/net/html"
)

func htmlToMarkdown(raw string) string {
	doc, err := html.Parse(strings.NewReader(raw))
	if err != nil {
		return strings.TrimSpace(raw)
	}
	var b strings.Builder
	writeMarkdown(&b, doc, false)
	return strings.TrimSpace(collapseBlank(b.String()))
}

func htmlToText(raw string) string {
	doc, err := html.Parse(strings.NewReader(raw))
	if err != nil {
		return strings.TrimSpace(raw)
	}
	var b strings.Builder
	writeText(&b, doc)
	return strings.TrimSpace(strings.Join(strings.Fields(b.String()), " "))
}

func writeMarkdown(b *strings.Builder, n *html.Node, inPre bool) {
	if n == nil || skipNode(n) {
		return
	}
	if n.Type == html.TextNode {
		text := n.Data
		if !inPre {
			text = strings.Join(strings.Fields(text), " ")
		}
		b.WriteString(text)
		return
	}
	if n.Type != html.ElementNode {
		for child := n.FirstChild; child != nil; child = child.NextSibling {
			writeMarkdown(b, child, inPre)
		}
		return
	}
	switch n.Data {
	case "h1", "h2", "h3", "h4", "h5", "h6":
		b.WriteString("\n\n")
		b.WriteString(strings.Repeat("#", int(n.Data[1]-'0')))
		b.WriteByte(' ')
		writeChildren(b, n, false)
		b.WriteString("\n\n")
	case "p", "div", "section", "article":
		b.WriteString("\n\n")
		writeChildren(b, n, false)
		b.WriteString("\n\n")
	case "br":
		b.WriteByte('\n')
	case "li":
		b.WriteString("\n- ")
		writeChildren(b, n, false)
	case "pre":
		b.WriteString("\n\n```\n")
		writeChildren(b, n, true)
		b.WriteString("\n```\n\n")
	case "code":
		if inPre {
			writeChildren(b, n, true)
			return
		}
		b.WriteByte('`')
		writeChildren(b, n, false)
		b.WriteByte('`')
	case "a":
		var inner strings.Builder
		writeChildren(&inner, n, false)
		label := strings.TrimSpace(inner.String())
		href := attr(n, "href")
		if href != "" && label != "" {
			b.WriteString("[" + label + "](" + href + ")")
			return
		}
		b.WriteString(label)
	case "strong", "b":
		b.WriteString("**")
		writeChildren(b, n, inPre)
		b.WriteString("**")
	case "em", "i":
		b.WriteByte('*')
		writeChildren(b, n, inPre)
		b.WriteByte('*')
	default:
		writeChildren(b, n, inPre)
	}
}

func writeChildren(b *strings.Builder, n *html.Node, inPre bool) {
	for child := n.FirstChild; child != nil; child = child.NextSibling {
		writeMarkdown(b, child, inPre)
	}
}

func writeText(b *strings.Builder, n *html.Node) {
	if n == nil || skipNode(n) {
		return
	}
	if n.Type == html.TextNode {
		b.WriteString(n.Data)
		b.WriteByte(' ')
		return
	}
	for child := n.FirstChild; child != nil; child = child.NextSibling {
		writeText(b, child)
	}
}

func skipNode(n *html.Node) bool {
	return n.Type == html.ElementNode && (n.Data == "script" || n.Data == "style" || n.Data == "noscript" || n.Data == "iframe" || n.Data == "object" || n.Data == "embed")
}

func attr(n *html.Node, key string) string {
	for _, item := range n.Attr {
		if item.Key == key {
			return item.Val
		}
	}
	return ""
}

func collapseBlank(s string) string {
	lines := strings.Split(s, "\n")
	var out []string
	blank := false
	for _, line := range lines {
		trimmed := strings.TrimRight(line, " \t")
		if strings.TrimSpace(trimmed) == "" {
			if blank {
				continue
			}
			blank = true
			out = append(out, "")
			continue
		}
		blank = false
		out = append(out, trimmed)
	}
	return strings.Join(out, "\n")
}
