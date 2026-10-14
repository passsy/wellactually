import { describe, expect, test } from "vitest";
import { detect, edit, prompt, read, source, write } from "@wellactually/sdk/v3/test";

const session = source`
  class Session {
    Session();
    late User user;
    int retries = 3;
  }
`;

test("fires on a late field the agent writes", () => {
  expect(detect(write("lib/session.dart", session))).toEqual([{ line: 3 }]);
});

test("stays quiet on a late field that was already there when the agent edits another line", () => {
  expect(detect(edit("lib/session.dart", session, { written: "  int retries = 3;" }))).toEqual([]);
});

test("stays quiet when the agent only reads the file", () => {
  expect(detect(read("lib/session.dart", session))).toEqual([]);
});

test("stays quiet on late in a comment or another word", () => {
  const code = source`
    // We used to have a late field here.
    final isolate = spawnIsolate();
  `;
  expect(detect(write("lib/messages.dart", code))).toEqual([]);
});

test("stays quiet in generated code", () => {
  const code = source`
    class _\$Session {
      late User user;
    }
  `;
  expect(detect(write("lib/session.g.dart", code))).toEqual([]);
});

const allowed = [
  { name: "local allowed", code: "void showToast(List<ToastItem> items) {\n  late final ToastItem item;\n  item = ToastItem(\n    onDismissed: () => items.remove(item),\n  );\n  items.add(item);\n}\n" },
  { name: "state allowed", code: "class AvoidLateStateAllowed extends State<Panel>\n    with SingleTickerProviderStateMixin {\n  late final AnimationController _controller = AnimationController(\n    vsync: this,\n  );\n}\n" },
  { name: "beacon controller allowed", code: "class AvoidLateBeaconControllerAllowed with BeaconController {\n  late final WritableBeacon<Map<String, List<String>>> actionBarOrders =\n      B.writable(const {});\n}\n" },
  { name: "beacon controller mixin allowed", code: "class AvoidLateBeaconControllerMixinAllowed extends State<Panel>\n    with BeaconControllerMixin<Panel> {\n  late final WritableBeacon<int> count = B.writable(0);\n}\n" },
  {
    name: "lazy State field that needs this",
    code: "class _PulseState extends State<Pulse> with SingleTickerProviderStateMixin {\n  late final controller = AnimationController(vsync: this);\n}\n",
  },
  {
    name: "State field assigned in initState",
    code: "class _PanelState extends State<Panel> {\n  late final SomeController _controller;\n\n  @override\n  void initState() {\n    super.initState();\n    _controller = SomeController();\n  }\n\n  @override\n  void dispose() {\n    _controller.dispose();\n    super.dispose();\n  }\n}\n",
  },
];

const inScope = [
  { name: "local without capture", code: "void showToast(List<ToastItem> items, VoidCallback dismiss) {\n  late final ToastItem item;\n  item = ToastItem(\n    onDismissed: () => dismiss(),\n    child: item,\n  );\n  items.add(item);\n}\n" },
  { name: "local not immediate", code: "void showToast(List<ToastItem> items) {\n  late final ToastItem item;\n  items.add(item);\n  item = ToastItem(onDismissed: () => items.remove(item));\n}\n" },
  { name: "state without this", code: "class AvoidLateStateWithoutThis extends State<Panel> {\n  late final AnimationController controller = AnimationController(\n    vsync: externalTicker,\n  );\n}\n" },
  { name: "non state with this", code: "class AvoidLateNonStateWithThis {\n  late final Controller controller = Controller(owner: this);\n}\n" },
  { name: "beacon controller unrelated field", code: "class AvoidLateBeaconControllerUnrelatedField with BeaconController {\n  late final ProjectStore store = ProjectStore();\n}\n" },
  { name: "non beacon controller with group", code: "class AvoidLateNonBeaconControllerWithGroup {\n  late final WritableBeacon<int> count = B.writable(0);\n}\n" },
  {
    name: "State field never assigned in initState",
    code: "class _PanelState extends State<Panel> {\n  late final SomeController _controller;\n\n  void attach() {\n    _controller = SomeController();\n  }\n}\n",
  },
];

describe("exceptions from the principle", () => {
  for (const { name, code } of allowed) {
    test(`allows ${name}`, () => {
      expect(detect(write("lib/example.dart", code))).toEqual([]);
    });
  }
  for (const { name, code } of inScope) {
    test(`keeps ${name} in scope`, () => {
      expect(detect(write("lib/example.dart", code))).toEqual([{ line: 2 }]);
    });
  }
});

const dartApp = { project: "fixtures/dart_app" };

test("points at the principle when the user pastes the runtime error", () => {
  const text = "The app crashes on startup with LateInitializationError: Field 'user' has not been initialized. Can you take a look?";
  expect(detect(prompt(text), dartApp)).toEqual([{ match: "LateInitializationError", depth: "pointer" }]);
});

test("stays quiet when late is about time", () => {
  expect(detect(prompt("The release is running late, can we cut the changelog step and ship later today?"), dartApp)).toEqual([]);
});
