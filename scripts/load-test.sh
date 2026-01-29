#!/bin/bash

# Load Test Script for Valerix Order Service
# Usage: ./load-test.sh <product_id>

set -o pipefail

PRODUCT_ID="${1:-1}"
ORDER_SERVICE_URL="${ORDER_SERVICE_URL:-http://localhost:3001}"
TOTAL_REQUESTS="${TOTAL_REQUESTS:-20}"
CONCURRENT_REQUESTS="${CONCURRENT_REQUESTS:-5}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-10}"
SLOW_THRESHOLD_MS="${SLOW_THRESHOLD_MS:-2000}"

# Results storage
RESULTS_FILE="load-test-results.json"
TEMP_DIR=$(mktemp -d)

echo "=========================================="
echo "  Valerix Load Test"
echo "=========================================="
echo "Product ID: $PRODUCT_ID"
echo "Order Service: $ORDER_SERVICE_URL"
echo "Total Requests: $TOTAL_REQUESTS"
echo "Concurrent Requests: $CONCURRENT_REQUESTS"
echo "Timeout: ${TIMEOUT_SECONDS}s"
echo "Slow Threshold: ${SLOW_THRESHOLD_MS}ms"
echo "=========================================="

# Initialize counters
successful=0
failed=0
slow_responses=0
total_time=0

# Arrays to store detailed results
declare -a all_results
declare -a slow_requests
declare -a failed_requests

# Function to make a single order request
make_order_request() {
    local request_id=$1
    local quantity=$2
    local result_file="$TEMP_DIR/result_$request_id.json"
    
    local start_time=$(date +%s%3N)
    
    # Make the request with timeout
    local http_response
    http_response=$(curl -s -w "\n%{http_code}\n%{time_total}" \
        --max-time "$TIMEOUT_SECONDS" \
        -X POST "$ORDER_SERVICE_URL/orders" \
        -H "Content-Type: application/json" \
        -d "{\"productId\": \"$PRODUCT_ID\", \"quantity\": $quantity}" 2>&1)
    
    local curl_exit_code=$?
    local end_time=$(date +%s%3N)
    local duration_ms=$((end_time - start_time))
    
    # Parse response
    local body=$(echo "$http_response" | head -n -2)
    local http_code=$(echo "$http_response" | tail -n 2 | head -n 1)
    local curl_time=$(echo "$http_response" | tail -n 1)
    
    # Handle curl timeout
    if [ $curl_exit_code -eq 28 ]; then
        http_code="TIMEOUT"
    fi
    
    # Determine status
    local status="success"
    local is_slow="false"
    local is_failed="false"
    
    if [ "$duration_ms" -gt "$SLOW_THRESHOLD_MS" ]; then
        is_slow="true"
    fi
    
    if [ "$http_code" != "200" ] && [ "$http_code" != "201" ]; then
        is_failed="true"
        status="failed"
    fi
    
    # Extract order ID if available
    local order_id=$(echo "$body" | jq -r '.id // .orderId // "N/A"' 2>/dev/null || echo "N/A")
    local order_status=$(echo "$body" | jq -r '.status // "UNKNOWN"' 2>/dev/null || echo "UNKNOWN")
    local error_msg=$(echo "$body" | jq -r '.error // ""' 2>/dev/null || echo "")
    
    # Write result to temp file
    cat > "$result_file" << EOF
{
    "request_id": $request_id,
    "order_id": "$order_id",
    "quantity": $quantity,
    "http_code": "$http_code",
    "duration_ms": $duration_ms,
    "status": "$status",
    "order_status": "$order_status",
    "is_slow": $is_slow,
    "is_failed": $is_failed,
    "error": "$error_msg",
    "timestamp": "$(date -Iseconds)"
}
EOF
    
    # Print progress
    local icon="✓"
    [ "$is_failed" = "true" ] && icon="✗"
    [ "$is_slow" = "true" ] && icon="⏱"
    
    printf "[%3d] %s HTTP %s | %4dms | Order: %s | Status: %s\n" \
        "$request_id" "$icon" "$http_code" "$duration_ms" "$order_id" "$order_status"
}

export -f make_order_request
export TEMP_DIR ORDER_SERVICE_URL PRODUCT_ID TIMEOUT_SECONDS SLOW_THRESHOLD_MS

echo ""
echo "Starting load test..."
echo "------------------------------------------"

# Run requests with controlled concurrency
for ((i=1; i<=TOTAL_REQUESTS; i++)); do
    # Vary quantity: use 13 for some requests to trigger gremlin
    if [ $((i % 7)) -eq 0 ]; then
        quantity=13  # Triggers gremlin delay
    else
        quantity=$((RANDOM % 5 + 1))
    fi
    
    # Run in background with concurrency limit
    make_order_request "$i" "$quantity" &
    
    # Limit concurrent requests
    if [ $((i % CONCURRENT_REQUESTS)) -eq 0 ]; then
        wait
    fi
done

# Wait for all remaining requests
wait

echo "------------------------------------------"
echo "Load test completed. Processing results..."
echo ""

# Aggregate results
total=0
successful=0
failed=0
slow_responses=0
total_time=0

slow_json="[]"
failed_json="[]"
all_json="[]"

for result_file in "$TEMP_DIR"/result_*.json; do
    if [ -f "$result_file" ]; then
        result=$(cat "$result_file")
        
        total=$((total + 1))
        
        duration=$(echo "$result" | jq '.duration_ms')
        total_time=$((total_time + duration))
        
        is_slow=$(echo "$result" | jq -r '.is_slow')
        is_failed=$(echo "$result" | jq -r '.is_failed')
        
        if [ "$is_failed" = "true" ]; then
            failed=$((failed + 1))
            failed_json=$(echo "$failed_json" | jq --argjson r "$result" '. + [$r]')
        else
            successful=$((successful + 1))
        fi
        
        if [ "$is_slow" = "true" ]; then
            slow_responses=$((slow_responses + 1))
            slow_json=$(echo "$slow_json" | jq --argjson r "$result" '. + [$r]')
        fi
        
        all_json=$(echo "$all_json" | jq --argjson r "$result" '. + [$r]')
    fi
done

# Calculate averages
avg_time=0
if [ $total -gt 0 ]; then
    avg_time=$((total_time / total))
fi

# Generate final report
cat > "$RESULTS_FILE" << EOF
{
    "summary": {
        "total_requests": $total,
        "successful": $successful,
        "failed": $failed,
        "slow_responses": $slow_responses,
        "avg_response_time_ms": $avg_time,
        "success_rate_percent": $(echo "scale=2; $successful * 100 / $total" | bc),
        "test_config": {
            "product_id": "$PRODUCT_ID",
            "concurrent_requests": $CONCURRENT_REQUESTS,
            "timeout_seconds": $TIMEOUT_SECONDS,
            "slow_threshold_ms": $SLOW_THRESHOLD_MS
        }
    },
    "slow_requests": $slow_json,
    "failed_requests": $failed_json,
    "all_requests": $all_json
}
EOF

# Cleanup temp directory
rm -rf "$TEMP_DIR"

# Print summary
echo "=========================================="
echo "  Test Results Summary"
echo "=========================================="
echo "Total Requests:     $total"
echo "Successful:         $successful"
echo "Failed:             $failed"
echo "Slow (>${SLOW_THRESHOLD_MS}ms):     $slow_responses"
echo "Avg Response Time:  ${avg_time}ms"
echo "Success Rate:       $(echo "scale=2; $successful * 100 / $total" | bc)%"
echo "=========================================="

if [ $slow_responses -gt 0 ]; then
    echo ""
    echo "⚠️  Slow Responses Detected:"
    echo "$slow_json" | jq -r '.[] | "  - Request \(.request_id): \(.duration_ms)ms (Order: \(.order_id))"'
fi

if [ $failed -gt 0 ]; then
    echo ""
    echo "❌ Failed Requests:"
    echo "$failed_json" | jq -r '.[] | "  - Request \(.request_id): \(.http_code) - \(.error) (Order: \(.order_id))"'
fi

echo ""
echo "Results saved to: $RESULTS_FILE"

# Exit with success - we record issues but don't fail the pipeline
# This allows the CI to complete and report findings
exit 0
