#!/bin/bash

OUTPUT="clientcodebase.txt"

# Clear/create output file
> "$OUTPUT"

# Find all .js, .jsx, and .css files, excluding node_modules and assets
find . -type f \( -name "*.js" -o -name "*.jsx" -o -name "*.css" \) \
  ! -path "./assets/*" \
  ! -path "./node_modules/*" | sort | while read -r file; do
    echo "========================================" >> "$OUTPUT"
    echo "FILE: $file" >> "$OUTPUT"
    echo "========================================" >> "$OUTPUT"
    cat "$file" >> "$OUTPUT"
    echo -e "\n" >> "$OUTPUT"
done

# Copy to /c/temp/
cp "$OUTPUT" /c/temp/

echo "Done! Output saved to $OUTPUT and copied to /c/temp/$OUTPUT"

