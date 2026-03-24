/*
  syphon_addon.mm
  Native Node addon — wraps SyphonMetalServer for Electron on Apple Silicon.
  Receives raw RGBA pixel data from the renderer and publishes via Syphon.
  Supports two concurrent servers: full-scene and overlay-only (transparent alpha).
*/

#include <napi.h>
#include <vector>

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <MetalKit/MetalKit.h>

#import "syphon-src/SyphonMetalServer.h"

// ── Module-level state ────────────────────────────────────────────────────────

// Shared Metal objects (one device and queue serves both servers)
static id<MTLDevice>       g_device  = nil;
static id<MTLCommandQueue> g_queue   = nil;

// Primary (full-scene) server
static SyphonMetalServer*  g_server  = nil;
static id<MTLTexture>      g_texture = nil;
static int g_texW = 0;
static int g_texH = 0;

// Overlay (alpha-only) server
static SyphonMetalServer*  g_overlay_server  = nil;
static id<MTLTexture>      g_overlay_texture = nil;
static int g_ovTexW = 0;
static int g_ovTexH = 0;

// Persistent flip buffer — avoids heap allocation on every frame
static std::vector<uint8_t> g_flipBuf;

// ── Shared helpers ────────────────────────────────────────────────────────────

static uint8_t* ExtractPixelPtr(const Napi::Value& val) {
    if (val.IsBuffer())
        return val.As<Napi::Buffer<uint8_t>>().Data();
    if (val.IsTypedArray()) {
        auto arr = val.As<Napi::TypedArray>();
        return static_cast<uint8_t*>(arr.ArrayBuffer().Data()) + arr.ByteOffset();
    }
    return nullptr;
}

// Upload pixels to a Metal texture and publish via a SyphonMetalServer.
// Both the primary and overlay servers use this path — no duplication.
//
// shouldFlip = true  → Canvas2D top-left origin; flip rows so Syphon gets bottom-left.
// shouldFlip = false → WebGL readPixels bottom-left origin; upload directly; no flip needed.
static bool PublishPixelsToServer(
    SyphonMetalServer* server,
    id<MTLTexture> __strong * texRef, int* texWRef, int* texHRef,
    uint8_t* pixels, int w, int h, bool shouldFlip)
{
    if (!server || !g_device) return false;

    NSUInteger bytesPerRow = (NSUInteger)w * 4;
    NSUInteger totalBytes  = bytesPerRow * (NSUInteger)h;

    // (Re-)create texture if canvas size changed
    if (!*texRef || *texWRef != w || *texHRef != h) {
        MTLTextureDescriptor* desc =
            [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                               width:(NSUInteger)w
                                                              height:(NSUInteger)h
                                                           mipmapped:NO];
        desc.usage = MTLTextureUsageShaderRead | MTLTextureUsageShaderWrite;
        *texRef  = [g_device newTextureWithDescriptor:desc];
        *texWRef = w;
        *texHRef = h;
    }

    const uint8_t* uploadPtr = pixels;
    if (shouldFlip) {
        // Flip rows vertically using persistent buffer (no heap allocation per frame)
        if (g_flipBuf.size() < totalBytes) g_flipBuf.resize(totalBytes);
        for (int row = 0; row < h; ++row) {
            memcpy(g_flipBuf.data() + (size_t)row * bytesPerRow,
                   pixels            + (size_t)(h - 1 - row) * bytesPerRow,
                   bytesPerRow);
        }
        uploadPtr = g_flipBuf.data();
    }

    [*texRef replaceRegion:MTLRegionMake2D(0, 0, (NSUInteger)w, (NSUInteger)h)
               mipmapLevel:0
                 withBytes:uploadPtr
               bytesPerRow:bytesPerRow];

    id<MTLCommandBuffer> cmd = [g_queue commandBuffer];
    [server publishFrameTexture:*texRef
                onCommandBuffer:cmd
                    imageRegion:NSMakeRect(0, 0, w, h)
                        flipped:NO];
    [cmd commit];
    return true;
}

// Ensure the shared Metal device and queue exist (idempotent)
static bool EnsureDevice(Napi::Env env) {
    if (g_device) return true;
    g_device = MTLCreateSystemDefaultDevice();
    if (!g_device) {
        napi_throw_error(env, nullptr, "No Metal device available");
        return false;
    }
    g_queue = [g_device newCommandQueue];
    return true;
}

// ── startServer(name?: string) → string ──────────────────────────────────────

Napi::Value StartServer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Stop any existing primary server (keep overlay server running if active)
    if (g_server) { [g_server stop]; g_server = nil; }
    g_texture = nil;
    g_texW = g_texH = 0;

    std::string name = "AV Club VJ";
    if (info.Length() > 0 && info[0].IsString())
        name = info[0].As<Napi::String>().Utf8Value();

    @autoreleasepool {
        setenv("SYPHON_APP_NAME", name.c_str(), 1);

        if (!EnsureDevice(env)) return env.Null();

        NSString* serverName = [NSString stringWithUTF8String:name.c_str()];
        g_server = [[SyphonMetalServer alloc] initWithName:serverName
                                                    device:g_device
                                                   options:nil];
        if (!g_server) {
            napi_throw_error(env, nullptr, "Failed to create SyphonMetalServer");
            return env.Null();
        }

        return Napi::String::New(env, name);
    }
}

// ── publishFrame(pixels, width, height) → bool ───────────────────────────────

Napi::Value PublishFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_server || !g_device) return Napi::Boolean::New(env, false);
    if (info.Length() < 3)       return Napi::Boolean::New(env, false);

    uint8_t* pixels = ExtractPixelPtr(info[0]);
    if (!pixels) return Napi::Boolean::New(env, false);

    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();

    @autoreleasepool {
        // WebGL readPixels is bottom-left origin — no flip needed (shouldFlip = false)
        bool ok = PublishPixelsToServer(g_server, &g_texture, &g_texW, &g_texH, pixels, w, h, false);
        return Napi::Boolean::New(env, ok);
    }
}

// ── stopServer() → undefined ─────────────────────────────────────────────────

Napi::Value StopServer(const Napi::CallbackInfo& info) {
    @autoreleasepool {
        if (g_server) { [g_server stop]; g_server = nil; }
        g_texture = nil;
        g_texW = g_texH = 0;
        // Only release shared Metal objects when the overlay server is also stopped
        if (!g_overlay_server) {
            g_queue  = nil;
            g_device = nil;
        }
    }
    return info.Env().Undefined();
}

// ── isRunning() → bool ───────────────────────────────────────────────────────

Napi::Value IsRunning(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), g_server != nil);
}

// ── startOverlayServer(name?: string) → string ───────────────────────────────

Napi::Value StartOverlayServer(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    // Stop any existing overlay server
    if (g_overlay_server) { [g_overlay_server stop]; g_overlay_server = nil; }
    g_overlay_texture = nil;
    g_ovTexW = g_ovTexH = 0;

    std::string name = "AV Club VJ Overlay";
    if (info.Length() > 0 && info[0].IsString())
        name = info[0].As<Napi::String>().Utf8Value();

    @autoreleasepool {
        // Reuse existing device/queue or create them if primary server not yet started
        if (!EnsureDevice(env)) return env.Null();

        NSString* serverName = [NSString stringWithUTF8String:name.c_str()];
        g_overlay_server = [[SyphonMetalServer alloc] initWithName:serverName
                                                            device:g_device
                                                           options:nil];
        if (!g_overlay_server) {
            napi_throw_error(env, nullptr, "Failed to create overlay SyphonMetalServer");
            return env.Null();
        }

        return Napi::String::New(env, name);
    }
}

// ── publishOverlayFrame(pixels, width, height) → bool ────────────────────────

Napi::Value PublishOverlayFrame(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!g_overlay_server || !g_device) return Napi::Boolean::New(env, false);
    if (info.Length() < 3)               return Napi::Boolean::New(env, false);

    uint8_t* pixels = ExtractPixelPtr(info[0]);
    if (!pixels) return Napi::Boolean::New(env, false);

    int w = info[1].As<Napi::Number>().Int32Value();
    int h = info[2].As<Napi::Number>().Int32Value();

    @autoreleasepool {
        // Canvas2D getImageData is top-left origin — flip to bottom-left for Syphon (shouldFlip = true)
        bool ok = PublishPixelsToServer(
            g_overlay_server, &g_overlay_texture, &g_ovTexW, &g_ovTexH, pixels, w, h, true);
        return Napi::Boolean::New(env, ok);
    }
}

// ── stopOverlayServer() → undefined ──────────────────────────────────────────

Napi::Value StopOverlayServer(const Napi::CallbackInfo& info) {
    @autoreleasepool {
        if (g_overlay_server) { [g_overlay_server stop]; g_overlay_server = nil; }
        g_overlay_texture = nil;
        g_ovTexW = g_ovTexH = 0;
        // Only release shared Metal objects when primary server is also stopped
        if (!g_server) {
            g_queue  = nil;
            g_device = nil;
        }
    }
    return info.Env().Undefined();
}

// ── isOverlayRunning() → bool ────────────────────────────────────────────────

Napi::Value IsOverlayRunning(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), g_overlay_server != nil);
}

// ── Module registration ───────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    // Primary server
    exports.Set("startServer",         Napi::Function::New(env, StartServer));
    exports.Set("publishFrame",        Napi::Function::New(env, PublishFrame));
    exports.Set("stopServer",          Napi::Function::New(env, StopServer));
    exports.Set("isRunning",           Napi::Function::New(env, IsRunning));
    // Overlay server (transparent alpha)
    exports.Set("startOverlayServer",  Napi::Function::New(env, StartOverlayServer));
    exports.Set("publishOverlayFrame", Napi::Function::New(env, PublishOverlayFrame));
    exports.Set("stopOverlayServer",   Napi::Function::New(env, StopOverlayServer));
    exports.Set("isOverlayRunning",    Napi::Function::New(env, IsOverlayRunning));
    return exports;
}

NODE_API_MODULE(syphon_addon, Init)
