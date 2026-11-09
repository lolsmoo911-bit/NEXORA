# Windows Proxy Grabber

Python 3 and Windows curl only. No third-party packages.

## What it does
- Fetches public lists from ProxyScrape, HProxy and monosans.
- Normalizes and deduplicates public IPv4 HTTP, HTTPS-proxy and SOCKS5 candidates.
- Rejects private, loopback, link-local and non-global addresses.
- Tests each candidate with one HTTPS request to api.ipify.org.
- Keeps TLS certificate verification enabled.
- Saves JSON, CSV and a text list of proxies that passed.

## Run
    py -3 proxy_grabber.py

Options:
    py -3 proxy_grabber.py --protocol socks5
    py -3 proxy_grabber.py --protocol http --limit-per-source 150
    py -3 proxy_grabber.py --limit-per-source 0 --concurrency 30 --timeout 8

Results go to the results folder:
- proxy-check-*.json: full check results and source attribution
- proxy-check-*.csv: spreadsheet report
- working-proxies-*.txt: endpoints that passed the HTTPS echo check
- latest-summary.json: latest totals

## Security boundary
These are public unauthenticated proxy servers operated by unknown parties. A successful check proves only that one HTTPS request passed at that moment. It does not prove ownership, privacy or uptime. Never send passwords, API keys, OAuth tokens, cookies, private source code or personal data through public proxies. This tool does not rotate proxies, change Windows networking, configure OpenCode or bypass account/workspace quotas.

## Sources
- https://github.com/proxyscrape/free-proxy-list
- https://github.com/hproxy-com/free-proxy-list
- https://github.com/monosans/proxy-list

