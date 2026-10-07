import { detect, edit, expect, prompt, read, source, test, write } from "@wellactually/sdk/test";

const session = source`
  class Session {
    Session();
    late User user;
    int retries = 3;
  }
`;

test("fires on a late field the agent writes", () => {
  expect(detect(write("lib/session.dart", session))).toEqual([{ line: 3, evidence: "late User user;" }]);
});

test("stays quiet on a late field that was already there when the agent edits another line", () => {
  expect(detect(edit("lib/session.dart", session, { written: "  int retries = 3;" }))).toEqual([]);
});

test("stays quiet when the agent only reads the file", () => {
  expect(detect(read("lib/session.dart", session))).toEqual([]);
});

test("stays quiet on late in a comment, a string or another word", () => {
  const code = source`
    // We used to have a late field here.
    const message = 'too late to cancel';
    final isolate = spawnIsolate();
  `;
  expect(detect(write("lib/messages.dart", code))).toEqual([]);
});

test("stays quiet on lazy initialization that needs this", () => {
  const code = source`
    class _PulseState extends State<Pulse> with SingleTickerProviderStateMixin {
      late final controller = AnimationController(vsync: this);
    }
  `;
  expect(detect(write("lib/pulse.dart", code))).toEqual([]);
});

test("stays quiet in generated code", () => {
  const code = source`
    class _$Session {
      late User user;
    }
  `;
  expect(detect(write("lib/session.g.dart", code))).toEqual([]);
});

test("points at the principle when the user pastes the runtime error", () => {
  const text = "The app crashes on startup with LateInitializationError: Field 'user' has not been initialized. Can you take a look?";
  expect(detect(prompt(text))).toEqual([{ evidence: "LateInitializationError", depth: "pointer" }]);
});

test("stays quiet when late is about time", () => {
  expect(detect(prompt("The release is running late, can we cut the changelog step and ship later today?"))).toEqual([]);
});
