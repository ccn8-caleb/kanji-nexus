package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Vocabulary metadata. Keep in sync with site/js/core/constants.js.
var (
	tagIDs    = set("suru", "intransitive", "transitive", "na-adj", "i-adj", "adverb", "kana")
	linkTypes = set("related", "antonym", "synonym", "derivative", "lookalike")
	sections  = []string{"kanji", "words", "links", "layout"}
)

func set(items ...string) map[string]bool {
	m := map[string]bool{}
	for _, s := range items {
		m[s] = true
	}
	return m
}

// Field order and omitempty mirror compactKanji / compactWord in site/js/core/schema.js.
type Kanji struct {
	On    []string `json:"on,omitempty"`
	Kun   []string `json:"kun,omitempty"`
	Notes string   `json:"notes,omitempty"`
	Color string   `json:"color,omitempty"`
}

type Word struct {
	Reading string   `json:"reading"`
	Meaning string   `json:"meaning,omitempty"`
	Tags    []string `json:"tags,omitempty"`
	Notes   string   `json:"notes,omitempty"`
	Color   string   `json:"color,omitempty"`
}

type Layout struct {
	Kanji map[string][2]float64 `json:"kanji"`
	Words map[string][2]float64 `json:"words"`
}

type Doc struct {
	Kanji  map[string]Kanji `json:"kanji"`
	Words  map[string]Word  `json:"words"`
	Links  [][]string       `json:"links"`
	Layout Layout           `json:"layout"`
}

const (
	defaultKanjiColor = "#3b82f6"
	defaultWordColor  = "#10b981"
)

func emptyDoc() *Doc {
	return &Doc{Kanji: map[string]Kanji{}, Words: map[string]Word{}, Links: [][]string{}, Layout: Layout{Kanji: map[string][2]float64{}, Words: map[string][2]float64{}}}
}

// readDir loads site/data/{kanji,words,links,layout}.json.
func readDir(dir string) (*Doc, error) {
	doc := emptyDoc()
	targets := map[string]any{"kanji": &doc.Kanji, "words": &doc.Words, "links": &doc.Links, "layout": &doc.Layout}
	for _, name := range sections {
		raw, err := os.ReadFile(filepath.Join(dir, name+".json"))
		if err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, targets[name]); err != nil {
			return nil, fmt.Errorf("%s.json: %w", name, err)
		}
	}
	doc.fillNil()
	return doc, nil
}

// readBundle loads an app backup / export (one file with all sections).
func readBundle(path string) (*Doc, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, err
	}
	if _, legacy := probe["primaryNodes"]; legacy {
		return nil, fmt.Errorf("%s uses the old primaryNodes format: load it in the app (💾 Data → Load .json), then download a new backup", path)
	}
	doc := emptyDoc()
	if err := json.Unmarshal(raw, doc); err != nil {
		return nil, err
	}
	doc.fillNil()
	return doc, nil
}

func (d *Doc) fillNil() {
	if d.Kanji == nil {
		d.Kanji = map[string]Kanji{}
	}
	if d.Words == nil {
		d.Words = map[string]Word{}
	}
	if d.Links == nil {
		d.Links = [][]string{}
	}
	if d.Layout.Kanji == nil {
		d.Layout.Kanji = map[string][2]float64{}
	}
	if d.Layout.Words == nil {
		d.Layout.Words = map[string][2]float64{}
	}
}

// ---------------------------------------------------------------------------
// Canonical text: one record per line, sorted. Must match sectionText in schema.js.
// ---------------------------------------------------------------------------

func compact(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return strings.TrimRight(buf.String(), "\n")
}

func block(open, close string, lines []string, indent int) string {
	if len(lines) == 0 {
		return open + close
	}
	pad := strings.Repeat("  ", indent+1)
	for i, l := range lines {
		lines[i] = pad + l
	}
	return open + "\n" + strings.Join(lines, ",\n") + "\n" + strings.Repeat("  ", indent) + close
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys) // byte order of UTF-8 == code point order
	return keys
}

func (d *Doc) kanjiText(indent int) string {
	var lines []string
	for _, k := range sortedKeys(d.Kanji) {
		e := d.Kanji[k]
		if e.Color == defaultKanjiColor {
			e.Color = ""
		}
		lines = append(lines, compact(k)+": "+compact(e))
	}
	return block("{", "}", lines, indent)
}

func (d *Doc) wordsText(indent int) string {
	keys := sortedKeys(d.Words)
	sort.SliceStable(keys, func(i, j int) bool {
		ri, rj := d.Words[keys[i]].Reading, d.Words[keys[j]].Reading
		if ri != rj {
			return ri < rj
		}
		return keys[i] < keys[j]
	})
	var lines []string
	for _, k := range keys {
		e := d.Words[k]
		if e.Color == defaultWordColor {
			e.Color = ""
		}
		lines = append(lines, compact(k)+": "+compact(e))
	}
	return block("{", "}", lines, indent)
}

func (d *Doc) linksText(indent int) string {
	links := make([][]string, len(d.Links))
	copy(links, d.Links)
	sort.SliceStable(links, func(i, j int) bool {
		if links[i][0] != links[j][0] {
			return links[i][0] < links[j][0]
		}
		return links[i][1] < links[j][1]
	})
	var lines []string
	for _, l := range links {
		lines = append(lines, compact(l))
	}
	return block("[", "]", lines, indent)
}

func posText(m map[string][2]float64, indent int) string {
	var lines []string
	for _, k := range sortedKeys(m) {
		p := m[k]
		lines = append(lines, fmt.Sprintf("%s: [%d,%d]", compact(k), int(math.Round(p[0])), int(math.Round(p[1]))))
	}
	return block("{", "}", lines, indent)
}

func (d *Doc) layoutText(indent int) string {
	return block("{", "}", []string{
		`"kanji": ` + posText(d.Layout.Kanji, indent+1),
		`"words": ` + posText(d.Layout.Words, indent+1),
	}, indent)
}

func (d *Doc) sectionText(name string, indent int) string {
	switch name {
	case "kanji":
		return d.kanjiText(indent)
	case "words":
		return d.wordsText(indent)
	case "links":
		return d.linksText(indent)
	default:
		return d.layoutText(indent)
	}
}

// normalizeLinks puts each pair in canonical order and drops exact duplicates,
// matching orderPair/linkKey in schema.js. Returns the number of duplicates removed.
func (d *Doc) normalizeLinks() int {
	seen := map[[2]string]bool{}
	out := [][]string{}
	dupes := 0
	for _, l := range d.Links {
		if len(l) < 2 {
			continue
		}
		a, b := l[0], l[1]
		if b < a {
			a, b = b, a
		}
		t := "related"
		if len(l) > 2 && linkTypes[l[2]] {
			t = l[2]
		}
		key := [2]string{a, b}
		if seen[key] {
			dupes++
			continue
		}
		seen[key] = true
		out = append(out, []string{a, b, t})
	}
	d.Links = out
	return dupes
}

func writeDir(d *Doc, dir string) ([]string, error) {
	var changed []string
	for _, name := range sections {
		path := filepath.Join(dir, name+".json")
		text := d.sectionText(name, 0) + "\n"
		old, _ := os.ReadFile(path)
		if string(old) == text {
			continue
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			return changed, err
		}
		changed = append(changed, path)
	}
	return changed, nil
}
