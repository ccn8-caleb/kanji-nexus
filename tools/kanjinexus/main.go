// kanjinexus: maintenance tool for the starter data in site/data/.
//
//	kanjinexus lint   [dir]            report problems (exit 1 on errors)
//	kanjinexus fmt    [-check] [dir]   rewrite files in canonical form
//	kanjinexus prune  [dir]            drop dangling links and stale layout entries
//	kanjinexus import <backup.json> [dir]   split an app backup into data files
//	kanjinexus dict build <jmdict.json> <out>  dictionary shards for the app (CI)
//	kanjinexus dict fill  <jmdict.json> [dir]  fill missing word meanings in data
//
// dir defaults to site/data (relative to the repo root).
package main

import (
	"flag"
	"fmt"
	"os"
)

const defaultDir = "site/data"

func usage() {
	fmt.Fprintln(os.Stderr, `usage:
  kanjinexus lint   [dir]
  kanjinexus fmt    [-check] [dir]
  kanjinexus prune  [dir]
  kanjinexus import <backup.json> [dir]
  kanjinexus dict build <jmdict-eng.json> <out-dir>
  kanjinexus dict fill  <jmdict-eng.json> [dir]`)
	os.Exit(2)
}

func dirArg(args []string, i int) string {
	if len(args) > i {
		return args[i]
	}
	return defaultDir
}

func die(err error) {
	fmt.Fprintln(os.Stderr, "error:", err)
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	cmd, args := os.Args[1], os.Args[2:]

	switch cmd {
	case "lint":
		dir := dirArg(args, 0)
		d, err := readDir(dir)
		if err != nil {
			die(err)
		}
		issues := lint(d, dir)
		errors := 0
		for _, is := range issues {
			if is.level == "error" {
				errors++
			}
			fmt.Printf("%-5s %-12s %s\n", is.level, is.file, is.msg)
		}
		fmt.Printf("%d kanji · %d words · %d links — %d errors, %d warnings\n",
			len(d.Kanji), len(d.Words), len(d.Links), errors, len(issues)-errors)
		if errors > 0 {
			os.Exit(1)
		}

	case "fmt":
		fs := flag.NewFlagSet("fmt", flag.ExitOnError)
		check := fs.Bool("check", false, "report files that are not canonical instead of rewriting them")
		_ = fs.Parse(args)
		dir := dirArg(fs.Args(), 0)
		d, err := readDir(dir)
		if err != nil {
			die(err)
		}
		if n := d.normalizeLinks(); n > 0 {
			fmt.Printf("dropped %d duplicate link(s)\n", n)
		}
		if *check {
			bad := 0
			for _, name := range sections {
				raw, _ := os.ReadFile(dir + "/" + name + ".json")
				if string(raw) != d.sectionText(name, 0)+"\n" {
					fmt.Printf("%s/%s.json is not canonical\n", dir, name)
					bad++
				}
			}
			if bad > 0 {
				os.Exit(1)
			}
			return
		}
		changed, err := writeDir(d, dir)
		if err != nil {
			die(err)
		}
		for _, p := range changed {
			fmt.Println("formatted", p)
		}

	case "prune":
		dir := dirArg(args, 0)
		d, err := readDir(dir)
		if err != nil {
			die(err)
		}
		for _, n := range prune(d) {
			fmt.Println(n)
		}
		d.normalizeLinks()
		if _, err := writeDir(d, dir); err != nil {
			die(err)
		}

	case "import":
		if len(args) < 1 {
			usage()
		}
		d, err := readBundle(args[0])
		if err != nil {
			die(err)
		}
		d.normalizeLinks()
		dir := dirArg(args, 1)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			die(err)
		}
		changed, err := writeDir(d, dir)
		if err != nil {
			die(err)
		}
		fmt.Printf("imported %d kanji · %d words · %d links (%d files changed)\n", len(d.Kanji), len(d.Words), len(d.Links), len(changed))

	case "dict":
		if len(args) < 2 {
			usage()
		}
		var err error
		switch args[0] {
		case "build":
			if len(args) < 3 {
				usage()
			}
			err = dictBuild(args[1], args[2])
		case "fill":
			err = dictFill(args[1], dirArg(args, 2))
		default:
			usage()
		}
		if err != nil {
			die(err)
		}

	default:
		usage()
	}
}
