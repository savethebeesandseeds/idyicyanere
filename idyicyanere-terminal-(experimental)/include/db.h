/* db.h */
/* based on the original work of: https://github.com/bradley499/flitdb/tree/main */
/* also used in project cuwacunu */
#ifndef idydb_h
#define idydb_h
#include <stdbool.h>

#define IDYDB_SUCCESS       0  // Successful operation
#define IDYDB_ERROR         1  // Unsuccessful operation
#define IDYDB_PERM          2  // Permission denied
#define IDYDB_BUSY          3  // The database file is locked
#define IDYDB_NOT_FOUND     4  // The database file is not found
#define IDYDB_CORRUPT       5  // The database file is malformed
#define IDYDB_RANGE         6  // The requested range is outside the range of the database
#define IDYDB_CREATE        7  // Create a database if not existent
#define IDYDB_READONLY      8  // Only allow the reading of the database
#define IDYDB_DONE          9  // The operation was completed successfully
#define IDYDB_NULL          10 // The operation resulted in a null lookup
#define IDYDB_INTEGER       11 // The value type of int
#define IDYDB_FLOAT         12 // The value type of float
#define IDYDB_CHAR          13 // The value type of char
#define IDYDB_BOOL          14 // The value type of bool
#define IDYDB_VECTOR        15 // The value type of vector<float>
#define IDYDB_UNSAFE        16 // Discard safety protocols to allow for larger database
#define IDYDB_VERSION  0x117ee // The current IdyDB version magic number

// Database sizing options
#define IDYDB_SIZING_MODE_TINY  1 // Handle databases up to 14.74 megabytes in size
#define IDYDB_SIZING_MODE_SMALL 2 // Handle databases up to 4.26 gigabytes in size
#define IDYDB_SIZING_MODE_BIG   3 // Handle databases up to 281.47 terabytes in size

// Database memory mapping
#define IDYDB_MMAP_ALLOWED 1 // Allows the database to memory map files - if possible (1 - allowed, 0 - disallowed)

// Database sizing selection
#define IDYDB_SIZING_MODE IDYDB_SIZING_MODE_BIG // The sizing mode for this compilation

#ifdef __cplusplus
#define idydb_extern extern "C"
#else
#define idydb_extern extern
#endif

typedef struct idydb idydb;
#if IDYDB_SIZING_MODE == IDYDB_SIZING_MODE_BIG
typedef unsigned long long idydb_column_row_sizing;
#else
typedef unsigned short idydb_column_row_sizing;
#endif

/**
 * @brief Configures the IdyDB handler to point to and operate on a specific file
 *
 * @param filename The path for the file to operate on
 * @param handler The IdyDB handler
 * @param flags The read write operation flags to set on the database file
 * @return int
 */
idydb_extern int idydb_open(const char *filename, idydb **handler, int flags);

/**
 * @brief Close the connection to the database, and delete the IdyDB handler object
 *
 * @param handler The IdyDB handler
 * @return int
 */
idydb_extern int idydb_close(idydb **handler);

/**
 * @brief Return the current version of the IdyDB API
 *
 * @return unsigned int
 */
idydb_extern unsigned int idydb_version_check();

/**
 * @brief Retrieve an error message from the IdyDB handler if once exists
 *
 * @param handler The IdyDB handler
 * @return char*
 */
idydb_extern char* idydb_errmsg(idydb **handler);

/**
 * @brief Extract a value stored within the IdyDB handler
 *
 * @param handler The IdyDB handler
 * @param column_position The column that you wish to extract the value from (1-based)
 * @param row_position The row that you wish to extract the value from (1-based)
 * @return int (status code)
 */
idydb_extern int idydb_extract(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position);

/**
 * @brief Retrieve a numeric representation of what data type was retrieved:
 *        IDYDB_NULL, IDYDB_INTEGER, IDYDB_FLOAT, IDYDB_CHAR, IDYDB_BOOL, IDYDB_VECTOR
 */
idydb_extern int idydb_retrieved_type(idydb **handler);

#ifdef __cplusplus
/**
 * @brief Insert an integer (int)
 */
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, int value);
#endif

idydb_extern int idydb_insert_int(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, int value);

#ifdef __cplusplus
/**
 * @brief Insert a float
 */
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, float value);
#endif

idydb_extern int idydb_insert_float(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, float value);

#ifdef __cplusplus
/**
 * @brief Insert a char*
 */
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, char* value);
#endif

idydb_extern int idydb_insert_char(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, char* value);

#ifdef __cplusplus
/**
 * @brief Insert a const char*
 */
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, const char* value);
#endif

idydb_extern int idydb_insert_const_char(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, const char* value);

#ifdef __cplusplus
/**
 * @brief Insert a boolean (bool)
 */
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, bool value);
#endif

idydb_extern int idydb_insert_bool(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, bool value);

/**
 * @brief Insert a vector<float> (embedding)
 *
 * Layout on disk: [type=6][uint16 dims][dims * float32 bytes]
 * @param dims must be <= 16383
 */
idydb_extern int idydb_insert_vector(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, const float* data, unsigned short dims);

/**
 * @brief Delete a value stored within the IdyDB handler
 */
idydb_extern int idydb_delete(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position);

/**
 * @brief Retrieve primitives from the last extracted value
 */
idydb_extern int   idydb_retrieve_int(idydb **handler);
idydb_extern float idydb_retrieve_float(idydb **handler);
idydb_extern char* idydb_retrieve_char(idydb **handler);
idydb_extern bool  idydb_retrieve_bool(idydb **handler);

/**
 * @brief Retrieve a vector from the last extracted value.
 * Returns an internal pointer valid until the next extract/insert/clear; do not free it.
 * On success, *out_dims is set to the vector dimensionality.
 */
idydb_extern const float* idydb_retrieve_vector(idydb **handler, unsigned short* out_dims);

/* --------------------------- Vector DB + RAG extensions --------------------------- */

/** Similarity metric for kNN search.
 *  Semantics: returned 'score' makes *higher better* for both metrics.
 *  - IDYDB_SIM_COSINE: cosine similarity in [-1, 1] (higher is more similar).
 *  - IDYDB_SIM_L2:     returns -L2 distance (higher (less negative) is more similar).
 */
typedef enum { IDYDB_SIM_COSINE = 1, IDYDB_SIM_L2 = 2 } idydb_similarity_metric;

typedef struct {
    idydb_column_row_sizing row; // 1-based row index
    float score;                 // higher is better
} idydb_knn_result;

/**
 * @brief Run kNN over a column that stores IDYDB_VECTOR values.
 * @param vector_column Column holding vectors (1-based)
 * @param query         Pointer to query vector (dim=dims)
 * @param dims          Dimensionality of query
 * @param k             Top-k (size of out_results array)
 * @param metric        IDYDB_SIM_COSINE or IDYDB_SIM_L2
 * @return number of results actually written into out_results (<=k), or <0 on error
 */
idydb_extern int idydb_knn_search_vector_column(idydb **handler,
                                                idydb_column_row_sizing vector_column,
                                                const float* query,
                                                unsigned short dims,
                                                unsigned short k,
                                                idydb_similarity_metric metric,
                                                idydb_knn_result* out_results);

/**
 * @brief Utility to get the next append position (max row in column + 1). Returns >=1.
 */
idydb_extern idydb_column_row_sizing idydb_column_next_row(idydb **handler, idydb_column_row_sizing column);

/* ---- RAG convenience: simple two-column (text, embedding) pattern ----
 * You choose a 'text' column and an 'embedding' column (must be distinct).
 * For each row:
 *   - (text_column, row)      -> IDYDB_CHAR text chunk
 *   - (vector_column, row)    -> IDYDB_VECTOR embedding
 */

/** Upsert a text chunk + embedding at a specific row (writes both columns). */
idydb_extern int idydb_rag_upsert_text(idydb **handler,
                                       idydb_column_row_sizing text_column,
                                       idydb_column_row_sizing vector_column,
                                       idydb_column_row_sizing row,
                                       const char* text,
                                       const float* embedding,
                                       unsigned short dims);

/** Embedding callback signature for auto-embedding text. The callee should allocate
 *  *out_vector (malloc or new), set *out_dims, and return 0 on success. The caller will free *out_vector.
 */
typedef int (*idydb_embed_fn)(const char* text, float** out_vector, unsigned short* out_dims, void* user);

/** Set or clear the embedding callback used by _auto_embed helpers. */
idydb_extern void idydb_set_embedder(idydb **handler, idydb_embed_fn fn, void* user);

/** Upsert text with auto-embedding via the configured embedder. */
idydb_extern int idydb_rag_upsert_text_auto_embed(idydb **handler,
                                                  idydb_column_row_sizing text_column,
                                                  idydb_column_row_sizing vector_column,
                                                  idydb_column_row_sizing row,
                                                  const char* text);

/** Query by embedding and retrieve top-k texts for a (text_column, vector_column) pair. 
 *  Allocates and returns copies of the top-k texts in out_texts[k]; caller must free each out_texts[i].
 *  Returns number of texts placed (<=k), or <0 on error.
 */
idydb_extern int idydb_rag_query_topk(idydb **handler,
                                      idydb_column_row_sizing text_column,
                                      idydb_column_row_sizing vector_column,
                                      const float* query_embedding,
                                      unsigned short dims,
                                      unsigned short k,
                                      idydb_similarity_metric metric,
                                      idydb_knn_result* out_results,
                                      char** out_texts);

/** Build a single concatenated context string from top-k results (joined by "\n---\n").
 *  Allocates a buffer and writes to *out_context; caller must free(*out_context).
 *  If max_chars > 0, truncates to that many characters (without breaking UTF-8 boundaries is not guaranteed).
 *  Returns 0 on success, or error code.
 */
idydb_extern int idydb_rag_query_context(idydb **handler,
                                         idydb_column_row_sizing text_column,
                                         idydb_column_row_sizing vector_column,
                                         const float* query_embedding,
                                         unsigned short dims,
                                         unsigned short k,
                                         idydb_similarity_metric metric,
                                         size_t max_chars,
                                         char** out_context);

#undef idydb_extern

#endif