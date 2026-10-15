import { describe, expect, test } from "vitest";
import { shellWrites } from "../src/shell.ts";

/** The files a command writes, with null for a file it wrote whole. */
const writes = (command: string) => Object.fromEntries(shellWrites(command, "/repo", "/home/me").map(({ file, fragments }) => [file, fragments]));

describe("a redirect writes a file", () => {
  test("a here-document into cat writes the whole file", () => {
    expect(writes("cat > lib/a.dart <<'EOF'\nfinal a = DateTime.now();\nEOF")).toEqual({ "/repo/lib/a.dart": null });
    expect(writes("cat <<EOF > lib/a.dart\nfinal a = 1;\nEOF")).toEqual({ "/repo/lib/a.dart": null });
    expect(writes("cat >lib/a.dart << \"EOF\"\nfinal a = 1;\nEOF")).toEqual({ "/repo/lib/a.dart": null });
  });

  test("an append adds only the here-document", () => {
    expect(writes("cat >> lib/a.dart <<EOF\nfinal b = 2;\nfinal c = 3;\nEOF")).toEqual({ "/repo/lib/a.dart": ["final b = 2;\nfinal c = 3;"] });
    expect(writes("echo 'final b = 2;' >> lib/a.dart")).toEqual({ "/repo/lib/a.dart": ["final b = 2;"] });
  });

  test("what a program printed into a file is not text the agent wrote", () => {
    expect(writes("dart run tool/gen.dart >> lib/a.dart")).toEqual({});
    expect(writes("git show HEAD~3:lib/a.dart > lib/a.dart")).toEqual({});
    expect(writes("curl -s https://example.com/a.js > web/vendor.js")).toEqual({});
    expect(writes("dart test &> out.txt")).toEqual({});
    expect(writes("cat lib/a.dart > lib/b.dart")).toEqual({});
  });

  test("text the command carries, written with >, is all of the file", () => {
    expect(writes("echo hi > a.txt")).toEqual({ "/repo/a.txt": null });
    expect(writes("echo hi &> a.txt")).toEqual({ "/repo/a.txt": null });
    expect(writes("echo hi >& a.txt")).toEqual({ "/repo/a.txt": null });
    expect(writes("echo hi >| a.txt")).toEqual({ "/repo/a.txt": null });
  });

  test("printf with a plain format is text the command carries", () => {
    expect(writes("printf 'final b = 2;\\n' >> lib/a.dart")).toEqual({ "/repo/lib/a.dart": ["final b = 2;\n"] });
    expect(writes("printf '%s\\n' x > lib/a.dart")).toEqual({});
  });

  test("a comparison is no redirect", () => {
    expect(writes("[[ a > b ]] && echo ok")).toEqual({});
    expect(writes("(( 3 > 2 )) && echo ok")).toEqual({});
  });

  test("standard error, other descriptors and devices are not files the agent wrote", () => {
    expect(writes("dart analyze 2> errors.txt")).toEqual({});
    expect(writes("dart analyze > /dev/null 2>&1")).toEqual({});
    expect(writes("echo oops >&2")).toEqual({});
  });

  test("tee writes every file it names", () => {
    expect(writes("tee lib/a.dart lib/b.dart <<EOF\nfinal a = 1;\nEOF")).toEqual({ "/repo/lib/a.dart": null, "/repo/lib/b.dart": null });
    expect(writes("cat <<EOF | tee -a lib/a.dart\nfinal a = 1;\nEOF")).toEqual({ "/repo/lib/a.dart": ["final a = 1;"] });
  });

  test("tee fed by a program writes nothing the agent wrote", () => {
    expect(writes("dart test | tee out.txt")).toEqual({});
    expect(writes("cat <<EOF | grep x | tee lib/a.dart\nx\nEOF")).toEqual({});
  });

  test("a <<- here-document drops the tabs before its end", () => {
    expect(writes("cat >> a.dart <<-EOF\n\tfinal a = 1;\n\tEOF\necho done")).toEqual({ "/repo/a.dart": ["final a = 1;"] });
  });
});

describe("what a command is made of", () => {
  test("several files in one command, each with its own here-document", () => {
    const command = "cat > a.dart <<'A'\nfinal a = 1;\nA\ncat >> b.dart <<'B'\nfinal b = 2;\nB";
    expect(writes(command)).toEqual({ "/repo/a.dart": null, "/repo/b.dart": ["final b = 2;"] });
  });

  test("a here-document's body is not read as commands", () => {
    expect(writes("cat >> a.sh <<'EOF'\necho x > b.txt\nEOF")).toEqual({ "/repo/a.sh": ["echo x > b.txt"] });
  });

  test("a > inside quotes, a comment or a here-string is no redirect", () => {
    expect(writes("echo 'a > b' \"c > d\"")).toEqual({});
    expect(writes("git status # > notes.txt")).toEqual({});
    expect(writes("grep x <<< 'a > b'")).toEqual({});
  });

  test("a path quoted for its spaces is still the path", () => {
    expect(writes("cat > 'my dir/a.dart' <<EOF\nx\nEOF")).toEqual({ "/repo/my dir/a.dart": null });
  });

  test("a path the shell expands is not known", () => {
    expect(writes('cat > "$TMPDIR/a.dart" <<EOF\nx\nEOF')).toEqual({});
    expect(writes("echo x > $(mktemp)")).toEqual({});
  });

  test("an absolute path or one from home does not depend on where the command runs", () => {
    expect(writes("echo x > /tmp/a.txt")).toEqual({ "/tmp/a.txt": null });
    expect(writes("echo x > ~/a.txt")).toEqual({ "/home/me/a.txt": null });
  });
});

describe("cd moves where paths are resolved from", () => {
  test("a path after cd is below the new directory", () => {
    expect(writes("mkdir -p app/test && cd app && cat > pubspec.yaml <<'EOF'\nname: app\nEOF")).toEqual({ "/repo/app/pubspec.yaml": null });
    expect(writes("cd /other\necho x > a.txt")).toEqual({ "/other/a.txt": null });
    expect(writes("cd\necho x > a.txt")).toEqual({ "/home/me/a.txt": null });
  });

  test("a cd in a subshell stays there", () => {
    expect(writes("(cd app && echo x > a.txt) && echo y > b.txt")).toEqual({ "/repo/app/a.txt": null, "/repo/b.txt": null });
  });

  test("after a cd to somewhere unknown only absolute paths are", () => {
    expect(writes("cd $DIR && echo x > a.txt && echo y > /tmp/b.txt")).toEqual({ "/tmp/b.txt": null });
    expect(writes("cd - && echo x > a.txt")).toEqual({});
    expect(writes("pushd app && echo x > a.txt")).toEqual({});
  });
});
