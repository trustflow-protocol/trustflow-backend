# Performance Monitoring

## Database Query Logging
The system monitors database queries via `DatabaseService`. Query execution times are logged automatically at the `debug` level.

### Slow Query Threshold
A query that takes longer than 500ms will trigger a `warn` log, indicating a potential performance bottleneck. These slow queries are tracked in Prometheus metrics.

### Prometheus Metrics
The following metrics are exposed on the `/metrics` endpoint (if configured):
- `db_query_count`: Total number of executed queries
- `db_slow_query_count`: Number of queries exceeding the slow threshold (500ms)
- `db_query_error_count`: Number of failed queries

By observing these metrics, you can trigger alerts when the database degrades.
