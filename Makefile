NAME    := run-a-script
VERSION := $(shell grep '"version"' manifest.json | sed 's/.*: "\(.*\)".*/\1/')

BUILD_DIR := build
DIST_DIR  := dist
XPI       := $(DIST_DIR)/$(NAME)-$(VERSION).xpi

SOURCES := manifest.json \
           background.js \
           settings.html \
           settings.js \
           jquery-3.7.1.min.js \
           GRenderer.js \
           icons/dog.svg \
           icons/dog-32.png \
           icons/dog-48.png \
           icons/dog-64.png \
           icons/dog-128.png

BUILD_FILES := $(addprefix $(BUILD_DIR)/,$(SOURCES))

.PHONY: all clean

all: $(XPI)

$(XPI): $(BUILD_FILES) | $(DIST_DIR)
	cd $(BUILD_DIR) && zip -r ../$(XPI) $(SOURCES)

$(BUILD_DIR)/icons/%: icons/% | $(BUILD_DIR)/icons
	cp $< $@

$(BUILD_DIR)/%: % | $(BUILD_DIR)
	cp $< $@

$(BUILD_DIR)/icons:
	mkdir -p $@

$(BUILD_DIR):
	mkdir -p $@

$(DIST_DIR):
	mkdir -p $@

clean:
	rm -rf $(BUILD_DIR) $(DIST_DIR)
