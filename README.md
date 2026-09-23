# fresnel

A browser network analyser for figuring out why Wi-Fi feels iffy.

Live: https://olii-dev.github.io/fresnel/

Hit **Run test** and leave the tab in front. It runs a sustained stability window (30s to 5m, or until you stop), then a multi-stream download and upload while it keeps pinging, then DNS timing, and finishes with a full report.

What it measures:

- **Latency** to Cloudflare's nearest edge, 4 probes a second, precise via Resource Timing with server time subtracted. Google RTT alongside for comparison.
- **Jitter**, spikes, and the full distribution (min to p99).
- **Loss and dropouts**: a probe with no reply in 2 s counts as lost; 2+ in a row is a stall. Checks whether Google also went dark to tell "your link" from "one site".
- **TCP retransmits** reported by the Cloudflare edge for your connection.
- **Bufferbloat**: how much latency rises while the line is saturated (graded A+ to F).
- **Throughput**: 4-stream download and upload, steady state, peak, variability.
- **DNS**: DoH resolver timing for 1.1.1.1 and 8.8.8.8, cached vs uncached, plus the cold connection breakdown (DNS / TCP / TLS / TTFB).
- **Network**: public IPv4/IPv6, ISP, ASN, location, Cloudflare edge, HTTP version, UDP/STUN reachability.
- **Device hints** from `navigator.connection` where the browser exposes them.

The report has a grade, a plain-English verdict, use-case ratings, worst 5 s windows, a per-second heatmap, an event timeline, and run history saved on the device. Copy it as text or export raw JSON.

Browsers can't read Wi-Fi radio details (signal strength, channel, band), so fresnel measures what the connection actually does instead.

Static site, no build step, no tracking. Endpoints: speed.cloudflare.com, google.com/generate_204, ipwho.is, ipify, cloudflare-dns.com, dns.google.
