import { describe, expect, it } from "vitest";
import {
  breadcrumbs,
  formatSize,
  parseRecent,
  type RecentFile,
  relativeTime,
  withRecent,
} from "./files";

const file = (path: string, openedAt = 0): RecentFile => ({
  path,
  name: path.split("/").pop() ?? path,
  games: 1,
  openedAt,
});

describe("recent files", () => {
  it("moves a reopened file to the front without duplicating it", () => {
    const list = [file("/a.pgn"), file("/b.pgn"), file("/c.pgn")];
    expect(withRecent(list, file("/b.pgn", 5)).map((f) => f.path)).toEqual([
      "/b.pgn",
      "/a.pgn",
      "/c.pgn",
    ]);
  });

  it("keeps at most twelve files", () => {
    let list: RecentFile[] = [];
    for (let i = 0; i < 20; i++) list = withRecent(list, file(`/${i}.pgn`));
    expect(list).toHaveLength(12);
    expect(list[0].path).toBe("/19.pgn");
  });

  it("drops stored entries that don't look right", () => {
    const stored = JSON.stringify([file("/a.pgn"), { path: 3 }, null, "x"]);
    expect(parseRecent(stored).map((f) => f.path)).toEqual(["/a.pgn"]);
    expect(parseRecent("not json")).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('{"path": "/a.pgn"}')).toEqual([]);
  });
});

describe("breadcrumbs", () => {
  it("splits Unix paths", () => {
    expect(breadcrumbs("/Users/mochi/Chess")).toEqual([
      { name: "/", path: "/" },
      { name: "Users", path: "/Users" },
      { name: "mochi", path: "/Users/mochi" },
      { name: "Chess", path: "/Users/mochi/Chess" },
    ]);
    expect(breadcrumbs("/")).toEqual([{ name: "/", path: "/" }]);
  });

  it("splits Windows paths", () => {
    expect(breadcrumbs("C:\\Users\\Mochi")).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "Mochi", path: "C:\\Users\\Mochi" },
    ]);
  });
});

it("formats sizes and times", () => {
  expect(formatSize(512)).toBe("512 B");
  expect(formatSize(12_800)).toBe("13 KB");
  expect(formatSize(3.4 * 1024 * 1024)).toBe("3.4 MB");
  const now = 1_000_000_000_000;
  expect(relativeTime(now - 10_000, now)).toBe("just now");
  expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
  expect(relativeTime(now - 26 * 3_600_000, now)).toBe("1 day ago");
});
