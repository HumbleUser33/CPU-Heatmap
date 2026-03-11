<img width="1238" height="942" alt="image" src="https://github.com/user-attachments/assets/8b397873-98a0-4d69-8045-39ea67acb89a" />


# CPU Sensor Heatmap

A Node.js tool that generates interactive CPU sensor heatmap dashboards from [CapFrameX](https://www.capframex.com/) benchmark JSON exports.

Each heatmap visualizes **time distribution per sensor value** using a green-to-red color gradient, giving you a detailed picture of how your CPU behaves during a benchmark session.

![CPU Sensor Heatmap Example](Heatmap%20example.png)

## Features

- **5 sensor metrics** displayed in a single combined dashboard:
  - **Core Frequency** (MHz) — per-core horizontal bars
  - **Thread Load** (%) — per-thread horizontal bars with average load indicators
  - **CPU Package Power** (W) — vertical bar with scale
  - **L3 Cache Hit Rate** (%) — vertical bar
  - **DRAM Bandwidth** (GB/s) — vertical bar with scale
- **Average thread load** shown as color-coded percentage squares next to each thread
- **Interactive tooltips** on hover showing exact values and time spent
- **Self-contained HTML output** — no dependencies, just open in a browser
- **Adaptive scales** with automatic range detection and anti-overlap label placement
- Handles any number of cores/threads dynamically

## Requirements

- [Node.js](https://nodejs.org/) (v14+)

## Usage

### Generate a heatmap

```bash
node generate-heatmap.js <capframex-export.json> [output.html]
```

- `<capframex-export.json>` — Path to a CapFrameX JSON session export
- `[output.html]` — Optional output path (defaults to `<input>-heatmap.html`)

**Example:**

```bash
node generate-heatmap.js CapFrameX-cod.exe-2026-03-09T18226.json
# -> Generates: CapFrameX-cod.exe-2026-03-09T18226-heatmap.html
```

Then open the generated `.html` file in any modern browser.

### Local preview server (optional)

A simple static file server is included for development:

```bash
node server.js
# -> http://localhost:8090
```

It serves `heatmap.html` by default from the project directory.

## How it works

1. **Parses** the CapFrameX JSON export (`Runs[0].SensorData2`)
2. **Extracts** sensor data: thread loads, core clocks, CPU power, L3 hit rate, DRAM bandwidth
3. **Builds histograms** — for each sensor, time is accumulated per value bucket using `BetweenMeasureTime` intervals as weights
4. **Computes averages** — weighted average load per thread over the full test duration
5. **Generates** a standalone HTML file with embedded data, CSS Grid layout, and vanilla JS rendering

### Color scale

The heatmap uses a **green &rarr; orange &rarr; red** gradient where:
- **Green** = low time spent at this value
- **Orange** = moderate time
- **Red** = most time spent (peak of the distribution)

Transparency scales with intensity, so empty buckets are invisible.

## Input format

The tool expects a standard CapFrameX JSON export containing:

```
{
  "Info": { "GameName", "Processor", "GPU", ... },
  "Runs": [{
    "SensorData2": {
      "BetweenMeasureTime": { "Values": [...] },
      "<sensor_key>": { "Type": "Load|Clock|Power|...", "Name": "...", "Values": [...] },
      ...
    }
  }]
}
```

Sensors are detected automatically by type and name pattern matching. Missing optional sensors (L3, Power, DRAM) are gracefully skipped.

## Project structure

```
generate-heatmap.js   # Main generator script
server.js             # Optional local preview server
```

## License

MIT
