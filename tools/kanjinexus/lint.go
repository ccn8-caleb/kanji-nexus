package main

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

type issue struct {
	level string // "error" | "warn"
	file  string
	msg   string
}

func labelOf(key string) string {
	if i := strings.Index(key, "#"); i >= 0 {
		return key[:i]
	}
	return key
}

// extractKanji mirrors util.js: unique Han characters, 々 resolves to the previous character.
func extractKanji(text string) []string {
	runes := []rune(text)
	var out []string
	seen := map[string]bool{}
	for i, r := range runes {
		if r == '々' && i > 0 {
			r = runes[i-1]
		}
		if unicode.Is(unicode.Han, r) && !seen[string(r)] {
			seen[string(r)] = true
			out = append(out, string(r))
		}
	}
	return out
}

func allIn(s string, tables ...*unicode.RangeTable) bool {
	for _, r := range s {
		if r == '.' || r == '-' || r == 'ー' {
			continue
		}
		if !unicode.In(r, tables...) {
			return false
		}
	}
	return true
}

func lint(d *Doc, dir string) []issue {
	var out []issue
	add := func(level, file, format string, args ...any) {
		out = append(out, issue{level, file, fmt.Sprintf(format, args...)})
	}

	for _, ch := range sortedKeys(d.Kanji) {
		k := d.Kanji[ch]
		if utf8.RuneCountInString(ch) != 1 {
			add("warn", "kanji.json", "%q: key should be a single character", ch)
		}
		for _, r := range k.On {
			if !allIn(r, unicode.Katakana) {
				add("warn", "kanji.json", "%s: on'yomi %q is not katakana", ch, r)
			}
		}
		for _, r := range k.Kun {
			if !allIn(r, unicode.Hiragana) {
				add("warn", "kanji.json", "%s: kun'yomi %q is not hiragana", ch, r)
			}
		}
	}

	used := map[string]bool{}
	for _, key := range sortedKeys(d.Words) {
		w := d.Words[key]
		if w.Reading == "" {
			add("warn", "words.json", "%s: missing reading", key)
		} else if !allIn(w.Reading, unicode.Hiragana) {
			add("warn", "words.json", "%s: reading %q is not all hiragana", key, w.Reading)
		}
		for _, t := range w.Tags {
			if !tagIDs[t] {
				add("error", "words.json", "%s: unknown tag %q", key, t)
			}
		}
		for _, ch := range extractKanji(labelOf(key)) {
			used[ch] = true
			if _, ok := d.Kanji[ch]; !ok {
				add("warn", "words.json", "%s: kanji %s is not in kanji.json (the word will not attach to it)", key, ch)
			}
		}
	}
	for _, ch := range sortedKeys(d.Kanji) {
		if !used[ch] {
			add("warn", "kanji.json", "%s: no words use this kanji", ch)
		}
	}

	seen := map[[2]string]bool{}
	for i, l := range d.Links {
		if len(l) != 3 {
			add("error", "links.json", "entry %d: expected [word, word, type]", i)
			continue
		}
		a, b, t := l[0], l[1], l[2]
		if !linkTypes[t] {
			add("error", "links.json", "%s–%s: unknown link type %q", a, b, t)
		}
		if a == b {
			add("error", "links.json", "%s: links to itself", a)
		}
		for _, end := range []string{a, b} {
			if _, ok := d.Words[end]; !ok {
				add("error", "links.json", "%s–%s: %q is not in words.json", a, b, end)
			}
		}
		key := [2]string{a, b}
		if b < a {
			key = [2]string{b, a}
		}
		if seen[key] {
			add("error", "links.json", "%s–%s: duplicate link", a, b)
		}
		seen[key] = true
	}

	checkPos := func(kind, k string, p []float64) {
		if len(p) != 2 && !(len(p) == 3 && (p[2] == 0 || p[2] == 1)) {
			add("error", "layout.json", "%s %s: position must be [x, y] or [x, y, 1] (pinned)", kind, k)
		}
	}
	for _, k := range sortedKeys(d.Layout.Kanji) {
		checkPos("kanji", k, d.Layout.Kanji[k])
		if _, ok := d.Kanji[k]; !ok {
			add("warn", "layout.json", "kanji %s: position for a kanji that does not exist", k)
		}
	}
	for _, k := range sortedKeys(d.Layout.Words) {
		checkPos("word", k, d.Layout.Words[k])
		if _, ok := d.Words[k]; !ok {
			add("warn", "layout.json", "word %s: position for a word that does not exist", k)
		}
	}

	// Formatting drift (sorting, spacing): fixable with `fmt`.
	if dir != "" {
		for _, name := range sections {
			raw, err := os.ReadFile(filepath.Join(dir, name+".json"))
			if err == nil && string(raw) != d.sectionText(name, 0)+"\n" {
				add("warn", name+".json", "not in canonical format (run: kanjinexus fmt)")
			}
		}
	}

	sort.SliceStable(out, func(i, j int) bool { return out[i].level == "error" && out[j].level != "error" })
	return out
}

// prune removes dangling links and stale layout entries. Returns a summary.
func prune(d *Doc) []string {
	var notes []string
	kept := [][]string{}
	for _, l := range d.Links {
		_, okA := d.Words[l[0]]
		_, okB := d.Words[l[1]]
		if len(l) == 3 && okA && okB && l[0] != l[1] {
			kept = append(kept, l)
		} else {
			notes = append(notes, fmt.Sprintf("removed link %v", l))
		}
	}
	d.Links = kept
	for k := range d.Layout.Kanji {
		if _, ok := d.Kanji[k]; !ok {
			delete(d.Layout.Kanji, k)
			notes = append(notes, "removed layout for kanji "+k)
		}
	}
	for k := range d.Layout.Words {
		if _, ok := d.Words[k]; !ok {
			delete(d.Layout.Words, k)
			notes = append(notes, "removed layout for word "+k)
		}
	}
	return notes
}
