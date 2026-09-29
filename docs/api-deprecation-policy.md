# API Deprecation Policy

## Versioning Strategy
The TrustFlow Backend API uses URI versioning (e.g., `/v1/...`) to manage backward compatibility and API evolution.

All current endpoints default to version `1` (`/v1/...`).

## Deprecation Process
When a breaking change is required, the API will follow these steps:
1. **New Version Release**: A new API version will be introduced (e.g., `/v2/...`) with the breaking changes. The older version (`/v1/...`) will continue to operate normally.
2. **Deprecation Notice**: The older version will be marked as deprecated in our API documentation and announced to developers via our communication channels.
3. **Sunset Period**: Deprecated endpoints will be supported for a minimum of 6 months after the deprecation notice.
4. **End of Life (EOL)**: After the sunset period, the deprecated version will be permanently removed. Calls to it will result in a `404 Not Found` or a relevant 4xx error.

We strive to make backward-compatible changes (e.g., adding new optional fields, adding new endpoints) whenever possible without introducing a new version.
