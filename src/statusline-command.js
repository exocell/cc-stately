#!/usr/bin/env node

// ---------------------------------------------------------------------------
// Renders a multi-row Claude Code statusline from the JSON payload on stdin.
// ---------------------------------------------------------------------------
//
// Available data:
// ├─ model                             Current Claude model metadata
// │  ├─ id                             Current model identifier
// │  └─ display_name                   Human-readable model name
// ├─ cwd                               Current working directory
// ├─ workspace                         Workspace path information
// │  ├─ current_dir                    Current directory, same value as cwd
// │  ├─ project_dir                    Directory where Claude Code was launched
// │  └─ added_dirs                     Extra directories added to the workspace
// ├─ cost                              Session timing, spend, and change totals
// │  ├─ total_cost_usd                 Total session cost in USD
// │  ├─ total_duration_ms              Total wall-clock session duration
// │  ├─ total_api_duration_ms          Total time spent waiting on API responses
// │  ├─ total_lines_added              Total lines of code added
// │  └─ total_lines_removed            Total lines of code removed
// ├─ context_window                    Context usage and token counters
// │  ├─ total_input_tokens             Cumulative input tokens for the session
// │  ├─ total_output_tokens            Cumulative output tokens for the session
// │  ├─ context_window_size            Maximum available context window size
// │  ├─ used_percentage                Percentage of context window used
// │  ├─ remaining_percentage           Percentage of context window remaining
// │  └─ current_usage                  Token usage details from the most recent API call
// ├─ exceeds_200k_tokens               Whether the latest response exceeded 200k total tokens
// ├─ rate_limits                       Usage and reset times for Claude Code quotas
// │  ├─ five_hour                      Rolling 5-hour rate limit window
// │  │  ├─ used_percentage             Percentage of the 5-hour limit consumed
// │  │  └─ resets_at                   Unix timestamp when the 5-hour window resets
// │  └─ seven_day                      Rolling 7-day rate limit window
// │     ├─ used_percentage             Percentage of the 7-day limit consumed
// │     └─ resets_at                   Unix timestamp when the 7-day window resets
// ├─ session_id                        Unique session identifier
// ├─ session_name                      Custom session name, when set
// ├─ transcript_path                   Path to the saved conversation transcript
// ├─ version                           Claude Code version string
// ├─ output_style                      Active output style information
// │  └─ name                           Current output style name
// ├─ vim                               Vim mode state when enabled
// │  └─ mode                           Current vim mode, such as NORMAL or INSERT
// ├─ agent                             Agent execution metadata
// │  └─ name                           Active agent name when agent mode is used
// └─ worktree                          Active worktree metadata for worktree sessions
//    ├─ name                           Worktree name
//    ├─ path                           Absolute worktree directory path
//    ├─ branch                         Git branch checked out in the worktree
//    ├─ original_cwd                   Directory before entering the worktree
//    └─ original_branch                Branch checked out before entering the worktree

const palette = {
  crust: [17, 17, 27],
  text: [205, 214, 244],
  mauve: [203, 166, 247],
  red: [243, 139, 168],
  sapphire: [116, 199, 236],
  teal: [148, 226, 213],
  peach: [250, 179, 135],
  yellow: [249, 226, 175],
  green: [166, 227, 161],
  pink: [245, 194, 231],
  blue: [137, 180, 250],
  lavender: [180, 190, 254],
};

const ansi = {
  fg: ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`,
  bg: ([r, g, b]) => `\x1b[48;2;${r};${g};${b}m`,
  inverse: "\x1b[7m",
  reset: "\x1b[0m",
};

const separators = {
  leading: (_, nextBg) =>
    `${ansi.fg(palette[nextBg])}${ansi.inverse}${ansi.reset}`,
  between: (currentBg, nextBg) =>
    `${ansi.fg(palette[currentBg])}${ansi.bg(palette[nextBg])}${ansi.reset}`,
  trailing: (currentBg) => `${ansi.fg(palette[currentBg])}${ansi.reset}`,
};

const statusRows = [
  [
    ["󱙺", "crust", "sapphire", ["model", "display_name"]],
    ["󰏗", "crust", "lavender", ["version"]],
    ["󰻞", "crust", "peach", ["context_window", "used_percentage"]],
    ["󱤦", "crust", "teal", ["rate_limits", "five_hour", "used_percentage"]],
    ["󱫥", "crust", "blue", ["rate_limits", "five_hour", "resets_at"]],
    ["󰨳", "crust", "pink", ["rate_limits", "seven_day", "used_percentage"]],
    ["󰇡", "crust", "red", ["rate_limits", "seven_day", "resets_at"]],
    ["", "crust", "yellow", ["cost", "total_duration_ms"]],
    ["󰠓", "crust", "green", ["cost", "total_cost_usd"]],
  ],
  [
    ["󰚩", "crust", "mauve", ["agent", "name"]],
    ["", "crust", "red", ["vim", "mode"]],
    ["", "crust", "lavender", ["worktree", "branch"]],
    ["󰦨", "crust", "green", ["cost"]],
  ],
];

// Formatting functions for specific data types
const formatDuration = (ms) => {
  if (ms == null) {
    return null;
  }

  const totalMinutes = Math.floor(ms / 1000 / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  return `${hours}h ${minutes}m`;
};
const formatTimeUntilEpoch = (epochSeconds) =>
  epochSeconds == null
    ? null
    : formatDuration(Math.max(0, epochSeconds * 1000 - Date.now()));
const formatCurrency = (value) =>
  value == null ? null : `$${value.toFixed(2)}`;
const formatLines = (added, removed) => `+${added || 0}/-${removed || 0}`;
const formatPercentage = (value) =>
  value == null ? "0%" : `${Math.floor(value)}%`;
const formatSegmentValue = (path, value) => {
  const pathKey = path.join(".");
  switch (pathKey) {
    case "context_window.used_percentage":
    case "rate_limits.five_hour.used_percentage":
    case "rate_limits.seven_day.used_percentage":
      return formatPercentage(value);
    case "cost.total_duration_ms":
      return formatDuration(value) || "0h 0m";
    case "rate_limits.five_hour.resets_at":
    case "rate_limits.seven_day.resets_at":
      return formatTimeUntilEpoch(value) || "0h 0m";
    case "cost.total_cost_usd":
      return formatCurrency(value);
    case "cost":
      return formatLines(value?.total_lines_added, value?.total_lines_removed);
    default:
      return value;
  }
};

// Rendering functions
const renderSegment = (segment) => {
  return [
    ansi.bg(palette[segment.bg]),
    ansi.fg(palette[segment.fg]),
    ` ${segment.text} ${ansi.reset}`,
  ].join("");
};

const renderRow = (row) => {
  const segments = row.filter(Boolean);

  if (segments.length === 0) {
    return "";
  }

  const items = [separators.leading(null, segments[0].bg)];

  segments.forEach((segment, index) => {
    const nextSegment = segments[index + 1];

    items.push(renderSegment(segment));
    items.push(
      nextSegment
        ? separators.between(segment.bg, nextSegment.bg)
        : separators.trailing(segment.bg),
    );
  });

  return items.join("");
};

// Utility functions
const getValueAtPath = (data, path) =>
  path.reduce((current, key) => current?.[key], data);

const createSegment = ({ icon, value, bg, fg = "crust" }) =>
  value ? { text: `${icon} ${value}`, bg, fg } : null;

const buildStatusRows = (data) =>
  statusRows.map((row) =>
    row.map(([icon, fg, bg, path]) =>
      createSegment({
        icon,
        value: formatSegmentValue(path, getValueAtPath(data, path)),
        bg,
        fg,
      }),
    ),
  );

const reportError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to render status line: ${message}`);
  process.exitCode = 1;
};

// Main function to read input, build status rows, and render output
const main = () => {
  let input = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    try {
      const data = JSON.parse(input);
      const output = buildStatusRows(data)
        .map(renderRow)
        .filter(Boolean)
        .join("\n");

      console.log(output);
    } catch (error) {
      reportError(error);
    }
  });
  process.stdin.on("error", (error) => reportError(error.message));
};

main();
