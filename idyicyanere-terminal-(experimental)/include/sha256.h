#ifndef SHA256_H
#define SHA256_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void sha256_bytes(const uint8_t *data, size_t len, uint8_t out[32]);

// out_hex must have space for 65 bytes (64 hex chars + NUL)
void sha256_hex(const uint8_t *data, size_t len, char out_hex[65]);

#ifdef __cplusplus
}
#endif
#endif
