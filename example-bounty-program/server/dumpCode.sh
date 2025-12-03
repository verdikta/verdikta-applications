#!/bin/bash

OUTPUT="servercodebase.txt"

# Clear/create output file
> "$OUTPUT"

# Find all .js files
find . -type f \( -name "*.js" \) \
  ! -path "./test/*" | sort | while read -r file; do
    echo "========================================" >> "$OUTPUT"
    echo "FILE: $file" >> "$OUTPUT"
    echo "========================================" >> "$OUTPUT"
    cat "$file" >> "$OUTPUT"
    echo -e "\n" >> "$OUTPUT"
done

# Copy to /c/temp/
cp "$OUTPUT" /c/temp/

echo "Done! Output saved to $OUTPUT and copied to /c/temp/$OUTPUT"

