package toolsearch

import (
	"math"
	"sort"
	"strings"
	"unicode"
)

// rank uses BM25 over names, server names and descriptions without an additional model call.
func rank(entries []*entry, query string, limit int) []*entry {
	terms := tokens(query)
	if len(terms) == 0 {
		return nil
	}
	type document struct {
		entry  *entry
		freq   map[string]int
		length int
		score  float64
	}
	docs := make([]document, 0, len(entries))
	frequency := map[string]int{}
	totalLength := 0
	for _, entry := range entries {
		doc := document{entry: entry, freq: map[string]int{}}
		name := entry.tool.Name()
		text := entry.source.Name + " " + name + " " + name + " " + name + " " + entry.tool.Description()
		for _, word := range tokens(text) {
			doc.freq[word]++
			doc.length++
		}
		for word := range doc.freq {
			frequency[word]++
		}
		totalLength += doc.length
		docs = append(docs, doc)
	}
	if len(docs) == 0 || totalLength == 0 {
		return nil
	}
	average := float64(totalLength) / float64(len(docs))
	for i := range docs {
		doc := &docs[i]
		for _, term := range terms {
			tf := float64(doc.freq[term])
			if tf == 0 {
				continue
			}
			df := float64(frequency[term])
			idf := math.Log(1 + (float64(len(docs))-df+0.5)/(df+0.5))
			doc.score += idf * tf * 2.2 / (tf + 1.2*(0.25+0.75*float64(doc.length)/average))
		}
		if strings.EqualFold(query, doc.entry.tool.Name()) || strings.EqualFold(query, doc.entry.name) {
			doc.score += 100
		}
	}
	sort.Slice(docs, func(i, j int) bool {
		if docs[i].score == docs[j].score {
			return docs[i].entry.name < docs[j].entry.name
		}
		return docs[i].score > docs[j].score
	})
	var out []*entry
	for _, doc := range docs {
		if doc.score <= 0 || len(out) >= limit {
			break
		}
		out = append(out, doc.entry)
	}
	return out
}

func tokens(text string) []string {
	var separated strings.Builder
	var previous rune
	for _, r := range text {
		if unicode.IsUpper(r) && (unicode.IsLower(previous) || unicode.IsDigit(previous)) {
			separated.WriteByte(' ')
		}
		separated.WriteRune(unicode.ToLower(r))
		previous = r
	}
	words := strings.FieldsFunc(separated.String(), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r)
	})
	out := make([]string, 0, len(words))
	for _, word := range words {
		out = append(out, word)
		// Bigrams let Chinese queries match phrases without a segmentation dependency.
		var han []rune
		for _, r := range word {
			if unicode.Is(unicode.Han, r) {
				han = append(han, r)
			} else {
				han = nil
			}
			if len(han) >= 2 {
				out = append(out, string(han[len(han)-2:]))
			}
		}
	}
	return out
}
