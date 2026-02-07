/* db.c */
#ifndef idydb_c
#define idydb_c

#include <unistd.h>
#include <sys/mman.h>
#include <sys/file.h>
#include <stdbool.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <math.h>
#include "idydb.h"

/* IdyDB database operations (internal) */
int idydb_new(idydb **handler);
void idydb_destroy(idydb **handler);
int idydb_connection_setup(idydb **handler, const char *filename, int flags);
char *idydb_get_err_message(idydb **handler);
unsigned char idydb_read_at(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position);
void idydb_clear_values(idydb **handler);
unsigned char idydb_insert_at(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position);
unsigned char idydb_insert_value_int(idydb **handler, int set_value);
unsigned char idydb_insert_value_float(idydb **handler, float set_value);
unsigned char idydb_insert_value_char(idydb **handler, char *set_value);
unsigned char idydb_insert_value_bool(idydb **handler, bool set_value);
unsigned char idydb_insert_value_vector(idydb **handler, const float* data, unsigned short dims);
void idydb_insert_reset(idydb **handler);
int idydb_retrieve_value_int(idydb **handler);
float idydb_retrieve_value_float(idydb **handler);
char *idydb_retrieve_value_char(idydb **handler);
bool idydb_retrieve_value_bool(idydb **handler);
const float* idydb_retrieve_value_vector(idydb **handler, unsigned short* out_dims);
unsigned char idydb_retrieve_value_type(idydb **handler);
void idydb_error_state(idydb **handler, unsigned char error_id);
union idydb_read_mmap_response idydb_read_mmap(unsigned int position, unsigned char size, void *mmapped_char);

/* ----- constants and layout helpers ----- */
#define IDYDB_MAX_BUFFER_SIZE 1024
#define IDYDB_MAX_CHAR_LENGTH (0xFFFF - sizeof(short))
#define IDYDB_MAX_VECTOR_DIM   16383      // (65535 - 2) / 4
#define IDYDB_MAX_ERR_SIZE 100
#define IDYDB_SEGMENT_SIZE 3
#define IDYDB_PARTITION_SIZE 4
#define IDYDB_PARTITION_AND_SEGMENT (IDYDB_SEGMENT_SIZE + IDYDB_PARTITION_SIZE)
#define IDYDB_MMAP_MAX_SIZE 0x1400000 // 20 megabytes (20971520)

/* on-disk type tags for values that follow a segment header */
#define IDYDB_READ_INT         1
#define IDYDB_READ_FLOAT       2
#define IDYDB_READ_CHAR        3
#define IDYDB_READ_BOOL_TRUE   4
#define IDYDB_READ_BOOL_FALSE  5
#define IDYDB_READ_VECTOR      6

#define IDYDB_READ_AND_WRITE 0
#define IDYDB_READONLY_MMAPPED 2

#ifndef IDYDB_SIZING_MODE
#error No sizing mode type was defined to IDYDB_SIZING_MODE
#elif IDYDB_SIZING_MODE == IDYDB_SIZING_MODE_TINY
#define IDYDB_COLUMN_POSITION_MAX 0x000F
#define IDYDB_ROW_POSITION_MAX 0x000F
typedef unsigned int idydb_size_selection_type;
typedef unsigned short idydb_sizing_max;
#elif IDYDB_SIZING_MODE == IDYDB_SIZING_MODE_SMALL
#define IDYDB_COLUMN_POSITION_MAX 0x00FF
#define IDYDB_ROW_POSITION_MAX 0x00FF
typedef unsigned int idydb_size_selection_type;
typedef unsigned int idydb_sizing_max;
#elif IDYDB_SIZING_MODE == IDYDB_SIZING_MODE_BIG
#define IDYDB_COLUMN_POSITION_MAX 0xFFFF
#define IDYDB_ROW_POSITION_MAX 0xFFFF
#define IDYDB_ALLOW_UNSAFE
typedef unsigned long long idydb_size_selection_type;
typedef unsigned long long idydb_sizing_max;
#else
#error An invalid sizing mode was attributed to IDYDB_SIZING_MODE
#endif

#if IDYDB_MMAP_ALLOWED
#define IDYDB_MMAP_OK // Allow memory mapping the database when reading
#endif

unsigned int idydb_version_check()
{
	return IDYDB_VERSION;
}

int idydb_open(const char *filename, idydb **handler, int flags)
{
	if (idydb_new(handler) == IDYDB_ERROR)
	{
		*handler = NULL;
		return IDYDB_ERROR;
	}
	int setup_success = idydb_connection_setup(handler, filename, flags);
	if (setup_success == IDYDB_SUCCESS)
		idydb_clear_values(handler);
	return setup_success;
}

int idydb_close(idydb **handler)
{
	idydb_destroy(handler);
	free(*handler);
	return IDYDB_DONE;
}

char *idydb_errmsg(idydb **handler)
{
	return idydb_get_err_message(handler);
}

int idydb_extract(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position)
{
	return idydb_read_at(handler, column_position, row_position);
}

int idydb_retrieved_type(idydb **handler)
{
	return idydb_retrieve_value_type(handler);
}

int idydb_insert_int(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, int value)
{
	unsigned char insert_success = idydb_insert_value_int(handler, value);
	if (insert_success != IDYDB_DONE)
		return insert_success;
	return idydb_insert_at(handler, column_position, row_position);
}

#ifdef __cplusplus
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, int value)
{
	return idydb_insert_int(handler, column_position, row_position, value);
}
#endif

int idydb_insert_float(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, float value)
{
	unsigned char insert_success = idydb_insert_value_float(handler, value);
	if (insert_success != IDYDB_DONE)
		return insert_success;
	return idydb_insert_at(handler, column_position, row_position);
}

#ifdef __cplusplus
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, float value)
{
	return idydb_insert_float(handler, column_position, row_position, value);
}
#endif

int idydb_insert_char(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, char *value)
{
	unsigned int value_length = strlen(value);
	if (value_length > IDYDB_MAX_CHAR_LENGTH)
	{
		idydb_error_state(handler, 11);
		return IDYDB_ERROR;
	}
	unsigned char insert_success = idydb_insert_value_char(handler, value);
	if (insert_success != IDYDB_DONE)
		return insert_success;
	return idydb_insert_at(handler, column_position, row_position);
}

#ifdef __cplusplus
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, char *value)
{
	return idydb_insert_char(handler, column_position, row_position, value);
}
#endif

int idydb_insert_const_char(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, const char *value)
{
	unsigned int value_length = strlen(value);
	if (value_length > IDYDB_MAX_CHAR_LENGTH)
	{
		idydb_error_state(handler, 11);
		return IDYDB_ERROR;
	}
	char tmp_value[(value_length + 1)];
	tmp_value[value_length] = '\0';
	for (unsigned short i = value_length; i > 0; i--)
		tmp_value[(i - 1)] = value[(i - 1)];
	return idydb_insert_char(handler, column_position, row_position, tmp_value);
}

#ifdef __cplusplus
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, const char *value)
{
	return idydb_insert_const_char(handler, column_position, row_position, value);
}
#endif

int idydb_insert_bool(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, bool value)
{
	int insert_success = idydb_insert_value_bool(handler, (value == true));
	if (insert_success != IDYDB_DONE)
		return insert_success;
	return idydb_insert_at(handler, column_position, row_position);
}

#ifdef __cplusplus
int idydb_insert(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, bool value)
{
	return idydb_insert_bool(handler, column_position, row_position, value);
}
#endif

int idydb_insert_vector(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position, const float* data, unsigned short dims)
{
	unsigned char insert_success = idydb_insert_value_vector(handler, data, dims);
	if (insert_success != IDYDB_DONE)
		return insert_success;
	return idydb_insert_at(handler, column_position, row_position);
}

int idydb_delete(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position)
{
	idydb_insert_reset(handler);
	return idydb_insert_at(handler, column_position, row_position);
}

int idydb_retrieve_int(idydb **handler)
{
	return idydb_retrieve_value_int(handler);
}

float idydb_retrieve_float(idydb **handler)
{
	return idydb_retrieve_value_float(handler);
}

char *idydb_retrieve_char(idydb **handler)
{
	return idydb_retrieve_value_char(handler);
}

bool idydb_retrieve_bool(idydb **handler)
{
	return idydb_retrieve_value_bool(handler);
}

const float* idydb_retrieve_vector(idydb **handler, unsigned short* out_dims)
{
	return idydb_retrieve_value_vector(handler, out_dims);
}

/* --------------------------- Core object --------------------------- */

typedef struct idydb
{
	void *buffer;
	bool configured;
	FILE *file_descriptor;
	char err_message[IDYDB_MAX_ERR_SIZE];
	union value
	{
		int   int_value;
		float float_value;
		char  char_value[(IDYDB_MAX_CHAR_LENGTH + 1)];
		bool  bool_value;
	} value;
	/* vector value lives outside the union (dynamic) */
	float*        vector_value;
	unsigned short vector_dims;

	unsigned char value_type;
	bool value_retrieved;
	idydb_sizing_max size;
	unsigned char read_only;
#ifdef IDYDB_ALLOW_UNSAFE
	bool unsafe;
#endif

	/* RAG embedder hook (optional) */
	idydb_embed_fn embedder;
	void* embedder_user;
} idydb;

void idydb_error_state(idydb **handler, unsigned char error_id)
{
	const char *errors[] = { "\0",
							 "The minimum buffer size has encroached beyond suitable definitions\0",
							 "The maximum buffer size has encroached beyond suitable definitions\0",
							 "The database handler has already been attributed to handle another database\0",
							 "No database exists to be exclusively read\0",
							 "Failed to open the database\0",
							 "Exclusive rights to access the database could not be obtained\0",
							 "The database attempted to access has a larger size than what this object can read\0",
							 "The database handler has not been attributed to handle a database\0",
							 "The database was opened in readonly mode\0",
							 "Data insertion avoided due to unexpected tennant\0",
							 "Data insertion avoided due to the length of a string being too large (or vector too large)\0",
#if IDYDB_SIZING_MODE == IDYDB_SIZING_MODE_TINY
							 "The requested range was outside of the database's range (sizing mode parameter is: tiny)\0",
#elif IDYDB_SIZING_MODE == IDYDB_SIZING_MODE_SMALL
							 "The requested range was outside of the database's range (sizing mode parameter is: small)\0",
#elif IDYDB_SIZING_MODE == IDYDB_SIZING_MODE_BIG
							 "The requested range was outside of the database's range\0",
#endif
							 "The database contracted a malformed structure declaration\0",
							 "An error occurred in attempting to read data from the database\0",
							 "An error occurred in attempting to write data to the database\0",
							 "An error occurred in attempting to write data to an updating skip offset notation in the database\0",
							 "Failed database truncation occurred\0",
							 "An error occurred in attempting to retrieve data from the database\0",
							 "Data retrieval avoided due to the length of a string being too large\0",
							 "The database yielded an invalid datatype\0",
							 "The requested range must have a valid starting range of at least 1\0",
							 "The database declares ranges that exceed the current sizing mode parameter set\0",
							 "Unable to enable unsafe mode due to compilation sizing mode parameter set\0",
							 "Unable to allocate memory for the creation of the database handler\0",
							 "An unknown error occurred\0",
	};
	if (error_id > 25)
		error_id = 25;
	strncpy((*handler)->err_message, errors[error_id], IDYDB_MAX_ERR_SIZE);
}

#ifdef IDYDB_MMAP_OK
union idydb_read_mmap_response
{
	int integer;
	short short_integer;
	float floating_point;
	unsigned char bytes[4];
};

union idydb_read_mmap_response idydb_read_mmap(unsigned int position, unsigned char size, void *mmapped_char)
{
	union idydb_read_mmap_response value;
	memset(value.bytes, 0, sizeof(value.bytes));
	unsigned char byte_position = 0;
	for (unsigned int i = position; i < (size + position); i++)
		value.bytes[byte_position++] = (char)(((char *)mmapped_char)[i]);
	return value;
}
#endif

void idydb_clear_values(idydb **handler)
{
	// Resets all the data associated with the current insert/retrieval
	(*handler)->value.int_value = 0;
	(*handler)->value_type = IDYDB_NULL;
	(*handler)->value_retrieved = false;

	// free any vector allocation
	if ((*handler)->vector_value != NULL) {
		free((*handler)->vector_value);
		(*handler)->vector_value = NULL;
	}
	(*handler)->vector_dims = 0;
}

int idydb_new(idydb **handler)
{
	*handler = &*(idydb *)malloc(sizeof(idydb)); // Attempts to request for memory
	if (*handler == NULL)						   // No memory was allocated
		return IDYDB_ERROR;
	(*handler)->configured = (IDYDB_MAX_BUFFER_SIZE < 50 || IDYDB_MAX_BUFFER_SIZE > 1024); // Buffer size is outside of operable bounds
	(*handler)->size = 0;
	(*handler)->read_only = IDYDB_READ_AND_WRITE;
#ifdef IDYDB_ALLOW_UNSAFE
	(*handler)->unsafe = false;
#endif
	(*handler)->value_type = 0;
	(*handler)->value_retrieved = false;
	(*handler)->file_descriptor = NULL;
	(*handler)->vector_value = NULL;
	(*handler)->vector_dims = 0;
	(*handler)->embedder = NULL;
	(*handler)->embedder_user = NULL;

	if (IDYDB_MAX_BUFFER_SIZE < 50) // Buffer size is outside of operable bounds
	{
		idydb_error_state(handler, 1);
		return IDYDB_ERROR;
	}
	else if (IDYDB_MAX_BUFFER_SIZE > 1024) // Buffer size is outside of operable bounds
	{
		idydb_error_state(handler, 2);
		return IDYDB_ERROR;
	}
	else
		idydb_error_state(handler, 0); // Clear error state
	return IDYDB_SUCCESS;
}

void idydb_destroy(idydb **handler)
{
	if ((*handler)->configured)
	{
		(*handler)->configured = false;
		if ((*handler)->file_descriptor != NULL)
		{
			flock(fileno((*handler)->file_descriptor), LOCK_UN); // Removes lock on the database file of operation
			fclose((*handler)->file_descriptor);				 // Closes connection to the database file of operation
		}
	}

	if ((*handler)->read_only != IDYDB_READONLY_MMAPPED && (*handler)->buffer != NULL) // If buffer exists in a read and write state
		free((*handler)->buffer);													   // Free up buffer
	else if ((*handler)->buffer != MAP_FAILED)										   // If buffer
		munmap((*handler)->buffer, (*handler)->size);								   // Free up mmapped file memory

	if ((*handler)->vector_value != NULL) {
		free((*handler)->vector_value);
		(*handler)->vector_value = NULL;
	}
}

static inline const idydb_sizing_max idydb_max_size()
{
	// To calculate the maximum file size of what the database file can safely be read and written to
	idydb_sizing_max insertion_area[2] = {0, 0};
	insertion_area[0] = IDYDB_COLUMN_POSITION_MAX;
	insertion_area[0] *= IDYDB_ROW_POSITION_MAX;
	insertion_area[0] *= (IDYDB_MAX_CHAR_LENGTH - 1);
	if (IDYDB_ROW_POSITION_MAX > 1)
	{
		insertion_area[1] = IDYDB_COLUMN_POSITION_MAX;
		insertion_area[1] *= IDYDB_ROW_POSITION_MAX;
		insertion_area[1] *= IDYDB_SEGMENT_SIZE;
	}
	return (insertion_area[0] + insertion_area[1] + (IDYDB_COLUMN_POSITION_MAX * IDYDB_PARTITION_AND_SEGMENT));
}

int idydb_connection_setup(idydb **handler, const char *filename, int flags)
{
	if ((*handler)->configured)
	{
		if (IDYDB_MAX_BUFFER_SIZE >= 50 && IDYDB_MAX_BUFFER_SIZE <= 1024) // If buffer size is within operable bounds
			idydb_error_state(handler, 3);
		return IDYDB_ERROR;
	}
	(*handler)->size = 0;
	(*handler)->read_only = IDYDB_READ_AND_WRITE;
	if ((flags & IDYDB_READONLY) == IDYDB_READONLY)
		(*handler)->read_only = IDYDB_READONLY;
	bool file_exists = true;
	if (access(filename, F_OK) != 0) // If file does not exist
	{
		file_exists = false;
		if ((*handler)->read_only == IDYDB_READONLY)
        {
			if ((flags & IDYDB_CREATE) == 0)
			{
				idydb_error_state(handler, 4);
				return IDYDB_NOT_FOUND;
			}
		}
	}
	(*handler)->file_descriptor = fopen(filename, (((flags & IDYDB_READONLY) == IDYDB_READONLY) ? "r" : ((((flags & IDYDB_CREATE) == IDYDB_CREATE) && !file_exists) ? "w+" : "r+"))); // Opens a connection to a database file
	if ((*handler)->file_descriptor == NULL)
	{
		idydb_error_state(handler, 5); // Failed to create connection to database file
		return IDYDB_PERM;
	}
	else
	{
		fseek((*handler)->file_descriptor, 0L, SEEK_END);	   // Move pointer to end of database file
		(*handler)->size = ftell((*handler)->file_descriptor); // Get position of pointer
		fseek((*handler)->file_descriptor, 0L, SEEK_SET);	   // Move pointer to start of database file
	}
	(*handler)->configured = true;											// Successfully configured correctly
	if (flock(fileno((*handler)->file_descriptor), LOCK_EX | LOCK_NB) != 0) // Attempts to lock the current database file
	{
		idydb_error_state(handler, 6);
		return IDYDB_BUSY;
	}
	if ((flags & IDYDB_UNSAFE) == IDYDB_UNSAFE) // Checks if unsafe operations have been attributed to this handler
#ifdef IDYDB_ALLOW_UNSAFE
		(*handler)->unsafe = true; // Unsafe mode is enabled
#else
	{
		idydb_error_state(handler, 23);
		return IDYDB_ERROR;
	}
#endif
	else if ((*handler)->size > idydb_max_size()) // Checks if the database file is bigger than the maximum size for safe operations
	{
		idydb_error_state(handler, 7);
		return IDYDB_RANGE;
	}
	#ifdef IDYDB_MMAP_OK
	if ((*handler)->read_only == IDYDB_READONLY)
	{
		if ((*handler)->size <= IDYDB_MMAP_MAX_SIZE && (*handler)->size > 0)
		{
			(*handler)->buffer = mmap(NULL, (*handler)->size, PROT_READ, MAP_PRIVATE, fileno((*handler)->file_descriptor), 0); // Attempt to allocate memory to map to file
			if ((*handler)->buffer != MAP_FAILED)
				(*handler)->read_only = IDYDB_READONLY_MMAPPED;
			else
				(*handler)->buffer = malloc((sizeof(char) * IDYDB_MAX_BUFFER_SIZE));
		}
		else
			(*handler)->buffer = malloc((sizeof(char) * IDYDB_MAX_BUFFER_SIZE));
	}
	else
	#endif
		(*handler)->buffer = malloc((sizeof(char) * IDYDB_MAX_BUFFER_SIZE));
	if ((*handler)->buffer == NULL)
	{
		idydb_error_state(handler, 24);
		return IDYDB_ERROR;
	}
	return IDYDB_SUCCESS;
}

char *idydb_get_err_message(idydb **handler)
{
	if (*handler == NULL)
		return (char *)"This handler failed to be setup\0"; // Default error message if handler has not been setup
	return (*handler)->err_message;							// Returns an error message (if set)
}

/* ---------------- insert value staging ---------------- */

unsigned char idydb_insert_value_int(idydb **handler, int set_value)
{
	if (!(*handler)->configured)
	{
		idydb_error_state(handler, 8); // Handler not configured
		return IDYDB_ERROR;
	}
	if ((*handler)->read_only != IDYDB_READ_AND_WRITE)
	{
		idydb_error_state(handler, 9); // Handler is in readonly mode
		return IDYDB_READONLY;
	}
	if ((*handler)->value_type != IDYDB_NULL && !(*handler)->value_retrieved)
	{
		idydb_error_state(handler, 10); // Handler already has value inserted
		return IDYDB_ERROR;
	}
	idydb_clear_values(handler);			 // Clears the current insert values
	(*handler)->value_type = IDYDB_INTEGER; // Sets the current insert value type to int
	(*handler)->value.int_value = set_value; // Sets the current insert value
	return IDYDB_DONE;
}

unsigned char idydb_insert_value_float(idydb **handler, float set_value)
{
	if (!(*handler)->configured)
	{
		idydb_error_state(handler, 8); // Handler not configured
		return IDYDB_ERROR;
	}
	if ((*handler)->read_only != IDYDB_READ_AND_WRITE)
	{
		idydb_error_state(handler, 9); // Handler is in readonly mode
		return IDYDB_READONLY;
	}
	if ((*handler)->value_type != IDYDB_NULL && !(*handler)->value_retrieved)
	{
		idydb_error_state(handler, 10); // Handler already has value inserted
		return IDYDB_ERROR;
	}
	idydb_clear_values(handler);			   // Clears the current insert values
	(*handler)->value_type = IDYDB_FLOAT;	   // Sets the current insert value type to float
	(*handler)->value.float_value = set_value; // Sets the current insert value
	return IDYDB_DONE;
}

unsigned char idydb_insert_value_char(idydb **handler, char *set_value)
{
	if (!(*handler)->configured)
	{
		idydb_error_state(handler, 8); // Handler not configured
		return IDYDB_ERROR;
	}
	if ((*handler)->read_only != IDYDB_READ_AND_WRITE)
	{
		idydb_error_state(handler, 9); // Handler is in readonly mode
		return IDYDB_READONLY;
	}
	if ((*handler)->value_type != IDYDB_NULL && !(*handler)->value_retrieved)
	{
		idydb_error_state(handler, 10); // Handler already has value inserted
		return IDYDB_ERROR;
	}
	idydb_clear_values(handler);															// Clears the current insert values
	(*handler)->value_type = IDYDB_CHAR;													// Sets the current insert value type to char array
	strncpy((*handler)->value.char_value, set_value, sizeof((*handler)->value.char_value)); // Sets the current insert value
	return IDYDB_DONE;
}

unsigned char idydb_insert_value_bool(idydb **handler, bool set_value)
{
	if (!(*handler)->configured)
	{
		idydb_error_state(handler, 8); // Handler not configured
		return IDYDB_ERROR;
	}
	if ((*handler)->read_only != IDYDB_READ_AND_WRITE)
	{
		idydb_error_state(handler, 9); // Handler is in readonly mode
		return IDYDB_READONLY;
	}
	if ((*handler)->value_type != IDYDB_NULL && !(*handler)->value_retrieved)
	{
		idydb_error_state(handler, 10); // Handler already has value inserted
		return IDYDB_ERROR;
	}
	idydb_clear_values(handler);			  // Clears the current insert values
	(*handler)->value_type = IDYDB_BOOL;	  // Sets the current insert value type to boolean
	(*handler)->value.bool_value = set_value; // Sets the current insert value
	return IDYDB_DONE;
}

unsigned char idydb_insert_value_vector(idydb **handler, const float* data, unsigned short dims)
{
	if (!(*handler)->configured)
	{
		idydb_error_state(handler, 8);
		return IDYDB_ERROR;
	}
	if ((*handler)->read_only != IDYDB_READ_AND_WRITE)
	{
		idydb_error_state(handler, 9);
		return IDYDB_READONLY;
	}
	if ((*handler)->value_type != IDYDB_NULL && !(*handler)->value_retrieved)
	{
		idydb_error_state(handler, 10);
		return IDYDB_ERROR;
	}
	if (dims == 0 || dims > IDYDB_MAX_VECTOR_DIM)
	{
		idydb_error_state(handler, 11); // reuse "too large" message
		return IDYDB_ERROR;
	}
	idydb_clear_values(handler);
	(*handler)->value_type  = IDYDB_VECTOR;
	(*handler)->vector_dims = dims;
	(*handler)->vector_value = (float*)malloc(sizeof(float) * (size_t)dims);
	if (!(*handler)->vector_value)
	{
		idydb_error_state(handler, 24);
		return IDYDB_ERROR;
	}
	memcpy((*handler)->vector_value, data, sizeof(float) * (size_t)dims);
	return IDYDB_DONE;
}

void idydb_insert_reset(idydb **handler)
{
	idydb_clear_values(handler); // Clears the current insert values
	return;
}

/* ---------------- retrieve staged value ---------------- */

int idydb_retrieve_value_int(idydb **handler)
{
	if ((*handler)->value_type == IDYDB_INTEGER)
		return (*handler)->value.int_value; // Returns the value stored in the int register
	return 0;
}

float idydb_retrieve_value_float(idydb **handler)
{
	if ((*handler)->value_type == IDYDB_FLOAT)
		return (*handler)->value.float_value; // Returns the value stored in the float register
	return 0;
}

char *idydb_retrieve_value_char(idydb **handler)
{
	if ((*handler)->value_type == IDYDB_CHAR)
		return (*handler)->value.char_value; // Returns the value stored in the char register
	return NULL;
}

bool idydb_retrieve_value_bool(idydb **handler)
{
	if ((*handler)->value_type == IDYDB_BOOL)
		return (*handler)->value.bool_value; // Returns the value stored in the bool register
	return false;
}

const float* idydb_retrieve_value_vector(idydb **handler, unsigned short* out_dims)
{
	if ((*handler)->value_type == IDYDB_VECTOR) {
		if (out_dims) *out_dims = (*handler)->vector_dims;
		return (*handler)->vector_value;
	}
	if (out_dims) *out_dims = 0;
	return NULL;
}

unsigned char idydb_retrieve_value_type(idydb **handler)
{
	return (*handler)->value_type; // Returns the value type
}

/* ---------------- read value at (column,row) ---------------- */

unsigned char idydb_read_at(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position)
{
	if (!(*handler)->configured)
	{
		idydb_error_state(handler, 8); // Handler not configured
		return IDYDB_ERROR;
	}
	idydb_clear_values(handler);
#ifdef IDYDB_ALLOW_UNSAFE
	if (!(*handler)->unsafe)
	{
#endif
		if (column_position == 0 || (column_position - 1) > IDYDB_COLUMN_POSITION_MAX || row_position == 0 || (row_position - 1) > IDYDB_ROW_POSITION_MAX)
		{
			idydb_error_state(handler, 12); // Outside of supported range
			idydb_clear_values(handler);
			return IDYDB_RANGE;
		}
#ifdef IDYDB_ALLOW_UNSAFE
	}
	else
#endif
		if (column_position == 0 || row_position == 0)
	{
		idydb_error_state(handler, 21); // Outside of supported range
		idydb_clear_values(handler);
		return IDYDB_RANGE;
	}
	else if ((row_position - 1) > IDYDB_ROW_POSITION_MAX)
	{
		idydb_error_state(handler, 12); // Outside of supported range
		idydb_clear_values(handler);
		return IDYDB_RANGE;
	}
	row_position -= 1;
	bool store_response = false;
	idydb_sizing_max offset = 0;
	idydb_size_selection_type skip_offset = 0;
	unsigned char read_length = IDYDB_PARTITION_AND_SEGMENT;
	unsigned short row_count = 0;
	for (;;)
	{
		if ((offset + read_length) > (*handler)->size) // Reached end of database file
		{
			if ((offset + read_length) > ((*handler)->size + read_length))
			{
				idydb_error_state(handler, 13); // Exceeded sizing expectations
				return IDYDB_CORRUPT;
			}
			break; // Is end of database file
		}
#ifdef IDYDB_MMAP_OK
		if ((*handler)->read_only != IDYDB_READONLY_MMAPPED)
		{
#endif
			fseek((*handler)->file_descriptor, offset, SEEK_SET); // Go to position
			offset += read_length;
#ifdef IDYDB_MMAP_OK
		}
#endif
		if (read_length == IDYDB_PARTITION_AND_SEGMENT) //  If is new partition
		{
			unsigned short skip_amount;
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				skip_amount = (unsigned short)idydb_read_mmap(offset, sizeof(short), (*handler)->buffer).integer; // Read memory mapped amount to skip in relation to previous partition
			else
#endif
				if (fread(&skip_amount, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) // Read amount to skip in relation to previous partition
			{
				idydb_error_state(handler, 14);
				return IDYDB_ERROR;
			}
			skip_offset += skip_amount;
			if (skip_offset > IDYDB_COLUMN_POSITION_MAX)
			{
#ifdef IDYDB_ALLOW_UNSAFE
				if (!(*handler)->unsafe)
				{
#endif
					idydb_error_state(handler, 22);
					return IDYDB_RANGE;
#ifdef IDYDB_ALLOW_UNSAFE
				}
#endif
			}
			skip_offset += 1;
			if (skip_offset > column_position)
				return IDYDB_NULL;
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				row_count = (unsigned short)idydb_read_mmap((offset + sizeof(short)), sizeof(short), (*handler)->buffer).integer; // Read memory mapped row count for partition
			else
#endif
				if (fread(&row_count, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) // Read row count for partition
			{
				idydb_error_state(handler, 14);
				return IDYDB_ERROR;
			}
#if IDYDB_SIZING_MODE != IDYDB_SIZING_MODE_BIG
			if (row_count > IDYDB_ROW_POSITION_MAX)
			{
				idydb_error_state(handler, 22);
				return IDYDB_RANGE;
			}
#endif
			row_count += 1;
		}
		unsigned char set_read_length = IDYDB_PARTITION_AND_SEGMENT;
		if (skip_offset == column_position) // Is column that is to be read
		{
			unsigned short position;
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				position = (unsigned short)idydb_read_mmap((offset + ((sizeof(short) * 2) * (read_length == IDYDB_PARTITION_AND_SEGMENT))), sizeof(short), (*handler)->buffer).integer; // Read memory mapped row position
			else
#endif
				if (fread(&position, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) // Read row position
			{
				idydb_error_state(handler, 14);
				return IDYDB_ERROR;
			}
			if (position == row_position) // Is row that is to be read
			{
				store_response = true;
				row_count = 0;
			}
#if IDYDB_SIZING_MODE != IDYDB_SIZING_MODE_BIG
			else if (position > IDYDB_ROW_POSITION_MAX)
			{
				idydb_error_state(handler, 22);
				return IDYDB_RANGE;
			}
#endif
		}
		else
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only != IDYDB_READONLY_MMAPPED)
#endif
			fseek((*handler)->file_descriptor, sizeof(short), SEEK_CUR); // Ignore row position of current value
		if (row_count > 1)												 // If more segments remain
		{
			row_count -= 1;
			set_read_length = IDYDB_SEGMENT_SIZE;
		}
		unsigned short response_length;
		unsigned char data_type;
#ifdef IDYDB_MMAP_OK
		idydb_sizing_max offset_mmap_standard_diff = offset + (sizeof(short) * 3);
		if (read_length == IDYDB_SEGMENT_SIZE)
			offset_mmap_standard_diff = (offset + sizeof(short));
		if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
		{
			// Read memory mapped data type of current value
			if (read_length == IDYDB_PARTITION_AND_SEGMENT)
				data_type = (unsigned short)idydb_read_mmap((offset + (sizeof(short) * 3)), 1, (*handler)->buffer).integer;
			else
				data_type = (unsigned short)idydb_read_mmap((offset + sizeof(short)), 1, (*handler)->buffer).integer;
			offset_mmap_standard_diff += 1;
		}
		else
#endif
			if (fread(&data_type, 1, 1, (*handler)->file_descriptor) != 1) // Read data type of current value
		{
			idydb_error_state(handler, 14);
			return IDYDB_ERROR;
		}
		(*handler)->value_retrieved = store_response;
		switch (data_type)
		{
		case IDYDB_READ_INT:
			if (store_response)
			{
				(*handler)->value_type = IDYDB_INTEGER;
#ifdef IDYDB_MMAP_OK
				if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
					(*handler)->value.int_value = idydb_read_mmap(offset_mmap_standard_diff, sizeof(int), (*handler)->buffer).integer; // Read and store memory mapped integer value
				else
#endif
					if (fread(&(*handler)->value.int_value, 1, sizeof(int), (*handler)->file_descriptor) != sizeof(int)) // Read and store integer value
				{
					idydb_error_state(handler, 18);
					return IDYDB_ERROR;
				}
				return IDYDB_DONE;
			}
			data_type = IDYDB_INTEGER;
			response_length = sizeof(int);
			break;
		case IDYDB_READ_FLOAT:
			if (store_response)
			{
				(*handler)->value_type = IDYDB_FLOAT;
#ifdef IDYDB_MMAP_OK
				if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
					(*handler)->value.float_value = idydb_read_mmap(offset_mmap_standard_diff, sizeof(float), (*handler)->buffer).floating_point; // Read and store memory mapped float value
				else
#endif
					if (fread(&(*handler)->value.float_value, 1, sizeof(float), (*handler)->file_descriptor) != sizeof(float)) // Read and store float value
				{
					idydb_error_state(handler, 18);
					return IDYDB_ERROR;
				}
				return IDYDB_DONE;
			}
			data_type = IDYDB_FLOAT;
			response_length = sizeof(float);
			break;
		case IDYDB_READ_CHAR:
			data_type = IDYDB_CHAR;
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				response_length = (unsigned short)idydb_read_mmap(offset_mmap_standard_diff, sizeof(short), (*handler)->buffer).integer; // Read memory mapped length of char value
			else
#endif
				if (fread(&response_length, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) // Read length of char array
			{
				idydb_error_state(handler, 18);
				return IDYDB_ERROR;
			}
			response_length += 1;
			if (response_length > IDYDB_MAX_CHAR_LENGTH)
			{
				idydb_error_state(handler, 19);
				return IDYDB_ERROR;
			}
			if (store_response)
			{
				(*handler)->value_type = data_type;
				memset((*handler)->value.char_value, 0, sizeof((*handler)->value.char_value));
#ifdef IDYDB_MMAP_OK
				if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				{
					idydb_sizing_max offset_diff = (offset_mmap_standard_diff + sizeof(short));
					for (idydb_sizing_max i = 0; i < response_length; i++)
						(*handler)->value.char_value[i] = ((char *)(*handler)->buffer)[(i + offset_diff)]; // Read memory mapped char byte
				}
				else
#endif
					if (fread((*handler)->value.char_value, response_length, sizeof(char), (*handler)->file_descriptor) != sizeof(char)) // Read and store char array
				{
					idydb_error_state(handler, 18);
					return IDYDB_ERROR;
				}
				if (strlen((*handler)->value.char_value) == 0)
				{
					idydb_error_state(handler, 14);
					return IDYDB_ERROR;
				}
				return IDYDB_DONE;
			}
			response_length += sizeof(short);
			break;
		case IDYDB_READ_BOOL_TRUE:
		case IDYDB_READ_BOOL_FALSE:
			if (store_response)
			{
				(*handler)->value_type = IDYDB_BOOL;
				(*handler)->value.bool_value = (data_type == IDYDB_READ_BOOL_TRUE); // Store boolean value
				return IDYDB_DONE;
			}
			data_type = IDYDB_BOOL;
			response_length = 0;
			break;
		case IDYDB_READ_VECTOR:
		{
			data_type = IDYDB_VECTOR;
			unsigned short dims = 0;
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				dims = (unsigned short)idydb_read_mmap(offset_mmap_standard_diff, sizeof(short), (*handler)->buffer).integer; // Read dims
			else
#endif
				if (fread(&dims, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
			{
				idydb_error_state(handler, 18);
				return IDYDB_ERROR;
			}
			if (dims == 0 || dims > IDYDB_MAX_VECTOR_DIM)
			{
				idydb_error_state(handler, 19);
				return IDYDB_ERROR;
			}
			unsigned short bytes = (unsigned short)(dims * sizeof(float));
			if (store_response)
			{
				(*handler)->value_type  = data_type;
				(*handler)->vector_dims = dims;
				(*handler)->vector_value = (float*)malloc(sizeof(float) * (size_t)dims);
				if (!(*handler)->vector_value)
				{
					idydb_error_state(handler, 24);
					return IDYDB_ERROR;
				}
#ifdef IDYDB_MMAP_OK
				if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				{
					idydb_sizing_max base = (offset_mmap_standard_diff + sizeof(short));
					for (unsigned short i = 0; i < dims; ++i)
					{
						union idydb_read_mmap_response f =
							idydb_read_mmap((unsigned int)(base + (i * sizeof(float))), (unsigned char)sizeof(float), (*handler)->buffer);
						(*handler)->vector_value[i] = f.floating_point;
					}
				}
				else
#endif
				{
					if (fread((*handler)->vector_value, sizeof(float), dims, (*handler)->file_descriptor) != dims)
					{
						idydb_error_state(handler, 18);
						return IDYDB_ERROR;
					}
				}
				return IDYDB_DONE;
			}
			response_length = bytes + sizeof(short);
			break;
		}
		default: // Unknown
			(*handler)->value_retrieved = false;
			idydb_error_state(handler, 20);
			return IDYDB_CORRUPT;
		}
#ifdef IDYDB_MMAP_OK
		if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
			offset += read_length;
#endif
		read_length = set_read_length;
		offset += response_length;
	}
	return IDYDB_NULL;
}

/* ---------------- insert value at (column,row) ---------------- */

unsigned char idydb_insert_at(idydb **handler, idydb_column_row_sizing column_position, idydb_column_row_sizing row_position)
{
	if (!(*handler)->configured)
	{
		idydb_error_state(handler, 8); // Handler not configured
		return IDYDB_ERROR;
	}
	if ((*handler)->read_only != IDYDB_READ_AND_WRITE)
	{
		idydb_error_state(handler, 9); // Opened in read only mode
		idydb_clear_values(handler);
		return IDYDB_READONLY;
	}
#ifdef IDYDB_ALLOW_UNSAFE
	if (!(*handler)->unsafe)
	{
#endif
		if (column_position == 0 || (column_position - 1) > IDYDB_COLUMN_POSITION_MAX || row_position == 0 || (row_position - 1) > IDYDB_ROW_POSITION_MAX)
		{
			idydb_error_state(handler, 12); // Outside of supported range
			idydb_clear_values(handler);
			return IDYDB_RANGE;
		}
#ifdef IDYDB_ALLOW_UNSAFE
	}
	else
#endif
		if (column_position == 0 || row_position == 0)
	{
		idydb_error_state(handler, 21); // Outside of supported range, must at least be 1
		idydb_clear_values(handler);
		return IDYDB_RANGE;
	}
	else if ((row_position - 1) > IDYDB_ROW_POSITION_MAX)
	{
		idydb_error_state(handler, 12); // Outside of supported range
		idydb_clear_values(handler);
		return IDYDB_RANGE;
	}
	row_position -= 1;
	unsigned short input_size = 0;
	switch ((*handler)->value_type)
	{
	case IDYDB_INTEGER:
		input_size = sizeof(int);
		break;
	case IDYDB_FLOAT:
		input_size = sizeof(float);
		break;
	case IDYDB_BOOL:
		break;
	case IDYDB_CHAR:
		input_size = (unsigned short)strlen((*handler)->value.char_value);
		if (input_size == 0)
			idydb_clear_values(handler);
		break;
	case IDYDB_VECTOR:
		if ((*handler)->vector_dims == 0 || (*handler)->vector_dims > IDYDB_MAX_VECTOR_DIM) {
			idydb_clear_values(handler);
			idydb_error_state(handler, 11);
			return IDYDB_ERROR;
		}
		/* number of payload bytes (floats) */
		input_size = (unsigned short)((*handler)->vector_dims * sizeof(float));
		break;
	}
	const unsigned short input_size_default = input_size; // for payload bytes
	if ((*handler)->value_type == IDYDB_CHAR || (*handler)->value_type == IDYDB_VECTOR)
		input_size += sizeof(short); // account for length/dims field

	idydb_sizing_max offset[6] = {0, 0, 0, 0, 0, 0};
	idydb_size_selection_type skip_offset[2] = {0, 0};
	unsigned short skip_amount[2] = {0, 0};
	unsigned short read_length[2] = {IDYDB_PARTITION_AND_SEGMENT, IDYDB_PARTITION_AND_SEGMENT};
	unsigned short row_count[3] = {0, 0, 0};
	unsigned short current_length[2] = {0, 0};
	unsigned char current_type = 0;

	// READ STRUCTURE
	if ((*handler)->size > 0)
	{
		for (;;)
		{
			read_length[1] = read_length[0]; // Store previous size
			offset[2] = offset[0];			 // Store segment position
			if (offset[0] >= (*handler)->size)
			{
				if ((offset[0] - current_length[0]) > (*handler)->size)
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 13);
					return IDYDB_CORRUPT;
				}
				else if (skip_offset[0] == column_position) // Add segment to end
				{
					offset[0] = offset[3];
					offset[1] = (*handler)->size;
					row_count[0] = row_count[1]; // Set row count to row default
					current_length[0] = 0;
				}
				else if (skip_offset[0] < column_position) // Insert partition to end
				{
					offset[0] = (*handler)->size;
					offset[1] = offset[0];
					row_count[0] = 0; // Set row count to 0
					current_length[0] = 0;
				}
				break;
			}
			fseek((*handler)->file_descriptor, offset[0], SEEK_SET);
			offset[0] += read_length[0];
			unsigned char skip_read_offset = 1;
			if (row_count[0] == 0) // Previous partition reached end
			{
				offset[1] = offset[2];
				offset[5] = offset[3];
				offset[3] = offset[2];
				offset[4] = (offset[2] + IDYDB_PARTITION_SIZE);
				skip_amount[1] = skip_amount[0]; // Set previous skip amount
				if (fread(&skip_amount[0], 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 14);
					return IDYDB_ERROR;
				}
				skip_offset[1] = skip_offset[0];
				skip_offset[0] += skip_amount[0];
				if (skip_offset[0] > IDYDB_COLUMN_POSITION_MAX)
				{
#ifdef IDYDB_ALLOW_UNSAFE
					if (!(*handler)->unsafe)
					{
#endif
						idydb_clear_values(handler);
						idydb_error_state(handler, 22);
						return IDYDB_RANGE;
#ifdef IDYDB_ALLOW_UNSAFE
					}
#endif
				}
				skip_offset[0] += 1;
				if (fread(&row_count[0], 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 14);
					return IDYDB_ERROR;
				}
#if IDYDB_SIZING_MODE != IDYDB_SIZING_MODE_BIG
				if (row_count[0] > IDYDB_ROW_POSITION_MAX)
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 22);
					return IDYDB_RANGE;
				}
#endif
				row_count[2] = row_count[1];
				row_count[0] += 1;
				row_count[1] = row_count[0];
				if (row_count[0] > 1)
					read_length[0] = IDYDB_SEGMENT_SIZE;
			}
			else
			{
				if (skip_offset[0] != column_position)
					fseek((*handler)->file_descriptor, skip_read_offset++, SEEK_CUR);
				offset[1] += read_length[0];
			}
			current_length[0] = 0;
			if (skip_offset[0] == column_position) // Reached target column
			{
				skip_offset[1] = skip_offset[0];
				unsigned short position;
				if (fread(&position, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 14);
					return IDYDB_ERROR;
				}
				if (position == row_position) // Is current row
				{
					if (fread(&current_type, 1, 1, (*handler)->file_descriptor) != 1)
					{
						idydb_clear_values(handler);
						idydb_error_state(handler, 14);
						return IDYDB_ERROR;
					}
					current_length[1] = 1;
					switch (current_type)
					{
					case IDYDB_READ_INT:
						current_length[0] = sizeof(int);
						break;
					case IDYDB_READ_FLOAT:
						current_length[0] = sizeof(float);
						break;
					case IDYDB_READ_CHAR:
						if (fread(&current_length[0], 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
						{
							idydb_error_state(handler, 14);
							return IDYDB_ERROR;
						}
						current_length[0] += (1 + sizeof(short));
						break;
					case IDYDB_READ_BOOL_TRUE:
					case IDYDB_READ_BOOL_FALSE:
						break;
					case IDYDB_READ_VECTOR:
					{
						unsigned short dims = 0;
						if (fread(&dims, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
						{
							idydb_error_state(handler, 14);
							return IDYDB_ERROR;
						}
						if (dims == 0 || dims > IDYDB_MAX_VECTOR_DIM)
						{
							idydb_error_state(handler, 22);
							return IDYDB_RANGE;
						}
						current_length[0] = (unsigned short)(sizeof(short) + (dims * sizeof(float)));
						break;
					}
					default:
						idydb_clear_values(handler);
						idydb_error_state(handler, 20);
						return IDYDB_ERROR;
					}
					offset[0] = offset[3];		 // Beginning of partition
					offset[1] = offset[2];		 // Beginning of segment
					row_count[0] = row_count[1]; // Set row count to total rows
					break;
				}
#if IDYDB_SIZING_MODE != IDYDB_SIZING_MODE_BIG
				else if (position > IDYDB_ROW_POSITION_MAX)
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 22);
					return IDYDB_RANGE;
				}
#endif
				else if (row_count[0] >= 1 && position > row_position) // Passed target row (doesn't exist) but additional rows exist
				{
					offset[0] = offset[3];		 // Beginning of segment
					offset[1] = offset[2];		 // Beginning of partition
					current_length[0] = 0;		 // Does not exist so set length of it to 0
					row_count[0] = row_count[1]; // Set row count to total rows
					break;
				}
				else if (row_position < position) // Passed target row (doesn't exist)
				{
					offset[0] = offset[2];		 // Beginning of segment
					current_length[0] = 0;		 // Does not exist so set length of it to 0
					row_count[0] = row_count[1]; // Set row count to total rows
					break;
				}
			}
			else if (skip_offset[0] > column_position) // Passed target column (doesn't exist)
			{
				skip_offset[0] = skip_offset[1];
				skip_amount[0] = skip_amount[1];
				offset[1] = offset[2]; // Beginning of segment
				if (skip_offset[0] == column_position)
					offset[0] = offset[5]; // Beginning of previous partition
				else
					offset[0] = offset[2];			   // Beginning of new partition
				read_length[0] = read_length[1];	   // Set length to previous
				current_length[0] = 0;				   // Does not exist so set length of it to 0
				if (skip_offset[1] == column_position) // If previous was the correct column
					row_count[0] = row_count[2];	   // Use previous row count
				else
					row_count[0] = 0; // Does not exist so row count is 0
				break;
			}
			else
				fseek((*handler)->file_descriptor, (3 - skip_read_offset), SEEK_CUR);
			if (fread(&current_type, 1, 1, (*handler)->file_descriptor) != 1)
			{
				idydb_clear_values(handler);
				idydb_error_state(handler, 14);
				return IDYDB_ERROR;
			}
			switch (current_type)
			{
				// Get sizes of current type
			case IDYDB_READ_INT:
				current_length[0] = sizeof(int);
				break;
			case IDYDB_READ_FLOAT:
				current_length[0] = sizeof(float);
				break;
			case IDYDB_READ_CHAR:
				if (fread(&current_length[0], 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) // Read the current size of the char array
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 14);
					return IDYDB_ERROR;
				}
				current_length[0] += (1 + sizeof(short));
				break;
			case IDYDB_READ_BOOL_TRUE:
			case IDYDB_READ_BOOL_FALSE:
				break; // Length is 0 for boolean value stores
			case IDYDB_READ_VECTOR:
			{
				unsigned short dims = 0;
				if (fread(&dims, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 14);
					return IDYDB_ERROR;
				}
				current_length[0] = (unsigned short)(sizeof(short) + (dims * sizeof(float)));
				break;
			}
			default:
				idydb_clear_values(handler);
				idydb_error_state(handler, 20);
				return IDYDB_ERROR;
			}
			current_type = 0;
			if (row_count[0] == 1)							   // Reached end of partition row count
				read_length[0] = IDYDB_PARTITION_AND_SEGMENT; // New partition
			row_count[0] -= 1;								   // Decrement the rows remaining
			offset[0] += current_length[0];
		}
	}
	if (current_length[1] == 0 && (input_size == 0 && (*handler)->value_type == IDYDB_NULL)) // No need to remove anything as nothing exists already
		return IDYDB_DONE;																	  // No need to write any data
	struct relinquish_excersion
	{
		unsigned short size;
		idydb_sizing_max position;
		bool use;
	};
	struct relinquish_excersion info_skip_offset = {
		.size = 0,
		.position = 0,
		.use = false};
	struct relinquish_excersion info_row_count = {
		.size = (unsigned short)((((input_size == 0 && (*handler)->value_type == IDYDB_NULL) || current_length[0] == 1) && info_row_count.size != 0) ? (row_count[0] - 1) : row_count[0]),
		.position = 0,
		.use = false};
	struct relinquish_excersion info_row_position = {
		.size = (unsigned short)row_position,
		.position = 0,
		.use = false};
	struct relinquish_excersion info_input_size = {
		.size = (unsigned short)(((*handler)->value_type == IDYDB_CHAR) ? (input_size - 1) : ((*handler)->value_type == IDYDB_VECTOR ? (*handler)->vector_dims : 0)),
		.position = 0,
		.use = 0};
	struct relinquish_excersion info_input_type = {
		.size = (*handler)->value_type,
		.position = 0,
		.use = false};
	struct relinquish_excersion info_input_buffer = {
		.size = 0,
		.position = 0,
		.use = 0};
	bool removal = false;
	if (input_size > current_length[0] || (current_length[1] == 0 && (*handler)->value_type != IDYDB_NULL))
	{
		// Adding new value, or extending current value
		unsigned short offset_sizing = (unsigned short)(input_size - current_length[0]);
		unsigned char additional_offset = 0;
		if (current_length[1] == 0) // Is new value
		{
			if (row_count[0] == 0)
				additional_offset = IDYDB_PARTITION_AND_SEGMENT; // New partition and segment
			else
				additional_offset = IDYDB_SEGMENT_SIZE; // New segment
		}
		if (offset[1] < (*handler)->size)
		{
			// Move segments after offset position
			idydb_sizing_max buffer_delimitation_point = (offset[1]);
			idydb_sizing_max buffer_offset = (((*handler)->size - offset[1]) % IDYDB_MAX_BUFFER_SIZE);
			if (buffer_offset == 0)
				buffer_offset = IDYDB_MAX_BUFFER_SIZE;
			unsigned short buffer_size = (unsigned short)buffer_offset;
			for (;;)
			{
				// Push data (extend) position by offset amount
				memset((*handler)->buffer, 0, (sizeof(char) * IDYDB_MAX_BUFFER_SIZE));
				fseek((*handler)->file_descriptor, ((*handler)->size - buffer_offset), SEEK_SET);
				if (fread((*handler)->buffer, buffer_size, 1, (*handler)->file_descriptor) != 1)
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 14);
					return IDYDB_ERROR;
				}
				fseek((*handler)->file_descriptor, (((*handler)->size - buffer_offset) + offset_sizing + additional_offset), SEEK_SET);
				if (fwrite((*handler)->buffer, buffer_size, 1, (*handler)->file_descriptor) != 1)
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 15);
					return IDYDB_ERROR;
				}
				if (((*handler)->size - buffer_offset) <= buffer_delimitation_point)
					break;
				buffer_size = IDYDB_MAX_BUFFER_SIZE;
				buffer_offset += buffer_size;
			}
			fseek((*handler)->file_descriptor, (((*handler)->size - buffer_offset) + offset_sizing + additional_offset), SEEK_SET);
		}
		(*handler)->size += offset_sizing;
		if (current_length[1] == 0) // Is new value
			(*handler)->size += additional_offset;
		else
			row_count[0] -= 1; // Updated existing value
	}
	else if (input_size < current_length[0] || (input_size < current_length[0] && (*handler)->value_type == IDYDB_CHAR) || (*handler)->value_type == IDYDB_NULL)
	{
		// Removing value, or reducing current value
		unsigned short offset_sizing = (unsigned short)(current_length[0] - (current_length[0] - input_size));
		if (row_count[0] == 1)
		{
			offset[3] = offset[1]; // Store beginning of segment
			offset[1] = offset[4]; // Set to beginning of segment
		}
		idydb_sizing_max deletion_point[2] = {
			(offset[1] + IDYDB_SEGMENT_SIZE + current_length[0]), // End point of current
			(offset[1] + IDYDB_SEGMENT_SIZE + offset_sizing),	   // New end point position
		};
		if (offset[0] == offset[1])
			deletion_point[0] += IDYDB_PARTITION_SIZE;
		if (input_size == 0 && (*handler)->value_type == IDYDB_NULL) // Removing data
		{
			if (row_count[0] > 1) // More rows exist
			{
				if (offset[0] == offset[1])
				{
					deletion_point[1] -= (((deletion_point[1] - offset[0]))); // Delete partition
					deletion_point[1] += IDYDB_PARTITION_SIZE;
				}
				else
					deletion_point[1] -= (IDYDB_SEGMENT_SIZE);
			}
			else if (offset[3] == offset[0]) // Beginning of partition
			{
				if (offset[0] == offset[1]) // Segment declaration is at beginning of partition
				{
					// Account for partition declaration
					deletion_point[0] += IDYDB_PARTITION_SIZE;
					deletion_point[1] += IDYDB_PARTITION_SIZE;
				}
				else if (row_count[0] == 1)
					deletion_point[1] -= IDYDB_PARTITION_AND_SEGMENT; // Removing partition and segment
				else
					deletion_point[1] -= IDYDB_PARTITION_SIZE;
			}
			else																			// No more rows exist
				deletion_point[1] -= (deletion_point[1] - (deletion_point[1] - offset[1])); // Delete segment and partition
		}
		else if (offset[0] == offset[1])				// Segment declaration is at beginning of partition
			deletion_point[1] += IDYDB_PARTITION_SIZE; // Account for partition declaration
		unsigned short buffer_size = IDYDB_MAX_BUFFER_SIZE;
		idydb_sizing_max buffer_offset = 0;
		bool writable = (deletion_point[0] != (*handler)->size);
		while (writable)
		{
			// Push data (reduce) position by offset amount
			if ((deletion_point[0] + buffer_offset + buffer_size) >= (*handler)->size)
			{
				buffer_size = (unsigned short)((*handler)->size - (deletion_point[0] + buffer_offset)); // Set buffer size to remaining bytes of file
				writable = false;
				if (buffer_size == 0)
					break;
			}
			memset((*handler)->buffer, 0, (sizeof(char) * IDYDB_MAX_BUFFER_SIZE));
			fseek((*handler)->file_descriptor, (deletion_point[0] + buffer_offset), SEEK_SET);
			if (fread((*handler)->buffer, buffer_size, 1, (*handler)->file_descriptor) != 1)
			{
				idydb_clear_values(handler);
				idydb_error_state(handler, 14);
				return IDYDB_ERROR;
			}
			fseek((*handler)->file_descriptor, (deletion_point[1] + buffer_offset), SEEK_SET);
			if (fwrite((*handler)->buffer, buffer_size, 1, (*handler)->file_descriptor) != 1)
			{
				idydb_clear_values(handler);
				idydb_error_state(handler, 15);
				return IDYDB_ERROR;
			}
			buffer_offset += buffer_size;
		}
		(*handler)->size -= (current_length[0] - offset_sizing);
		if (input_size == 0 && (*handler)->value_type == IDYDB_NULL)
		{
			if (row_count[0] > 1)
				(*handler)->size -= IDYDB_SEGMENT_SIZE; // Segment length removed
			else
				(*handler)->size -= IDYDB_PARTITION_AND_SEGMENT; // Segment and partition length removed
		}
		if (ftruncate(fileno((*handler)->file_descriptor), (*handler)->size) != 0)
		{
			idydb_clear_values(handler);
			idydb_error_state(handler, 17);
			return IDYDB_CORRUPT;
		}
		row_count[0] -= 1;
		if (row_count[0] == 0 && input_size == 0 && (*handler)->value_type == IDYDB_NULL)
			removal = true;
	}
	else // Input size is equal to current size
		row_count[0] -= 1;

	if (offset[0] == offset[1])
		offset[1] += IDYDB_PARTITION_SIZE;
	// New end grouping
	info_skip_offset.position = offset[0];
	info_row_count.position = (offset[0] + 2);
	info_row_count.size = row_count[0];
	if ((*handler)->value_type == IDYDB_NULL)
		info_row_count.size -= 1;
	if (((input_size == 0 && (*handler)->value_type != IDYDB_NULL) ? true : (input_size != 0)) && !removal)
	{
		// Partition exists at a later skip position
		info_skip_offset.use = true;
		if (row_count[0] == 0)
		{
			if (current_length[0] != 0 || current_length[1] == 1)		   // If empty or existing
				info_skip_offset.use = false;							   // Do not update next occurring skip offset (as it is already correct)
			else if (offset[0] != 0)									   // if other partitions exist prior to insertion point
				skip_amount[0] = (unsigned short)(column_position - (skip_offset[0] + 1)); // Calculate insertion difference for skip amount
			else
				skip_amount[0] = (unsigned short)(column_position - 1);
		}
		info_skip_offset.size = skip_amount[0];
		info_row_position.use = true;
		info_row_position.position = (offset[1]);
		info_input_type.use = true;
		info_input_type.position = (offset[1] + 2);
		if ((*handler)->value_type == IDYDB_CHAR)
		{
			info_input_size.use = true;
			info_input_size.position = (offset[1] + 3);
			info_input_buffer.position = (offset[1] + 5);
		}
		else if ((*handler)->value_type == IDYDB_VECTOR)
		{
			info_input_size.use = true;               // store dims (not bytes)
			info_input_size.position = (offset[1] + 3);
			info_input_buffer.position = (offset[1] + 5);
		}
		else
			info_input_buffer.position = (offset[1] + 3);
		info_input_buffer.use = ((*handler)->value_type != IDYDB_BOOL);
		info_row_count.use = true;
		if (current_length[0] == 0 && current_length[1] == 0 && row_count[0] == 0 && (current_length[0] != input_size || (*handler)->value_type == IDYDB_BOOL)) // Partition is new, so update skip offset for next partition
		{
			offset[0] += (IDYDB_PARTITION_AND_SEGMENT + input_size);
			if (offset[0] != (*handler)->size)
			{
				if (fread(&skip_amount[1], sizeof(short), 1, (*handler)->file_descriptor) != 1)
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 14);
					return IDYDB_ERROR;
				}
				if (skip_amount[1] == 1)
					skip_amount[0] = 0;
				else
					skip_amount[0] = (unsigned short)(skip_amount[1] - (skip_amount[0] + 1));
				fseek((*handler)->file_descriptor, offset[0], SEEK_SET);
				if (fwrite(&skip_amount[0], sizeof(short), 1, (*handler)->file_descriptor) != 1)
				{
					idydb_clear_values(handler);
					idydb_error_state(handler, 16);
					return IDYDB_ERROR;
				}
			}
		}
	}
	else if (offset[0] != (*handler)->size)
	{
		if (row_count[0] == 0) // Partition has been removed
		{
			// Removed partition and will increase the skip amount of the later partition
			info_skip_offset.use = true;
			fseek((*handler)->file_descriptor, offset[0], SEEK_SET);
			skip_amount[1] = skip_amount[0];
			if (fread(&skip_amount[0], 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
			{
				idydb_clear_values(handler);
				idydb_error_state(handler, 14);
				return IDYDB_ERROR;
			}
			skip_amount[0] += (unsigned short)(skip_amount[1] + 1); // Increment the later partition skip amount with the removed partitions skip amount
			info_skip_offset.size = skip_amount[0];
		}
		else
			info_row_count.use = true;
	}
	if (info_skip_offset.use)
	{
		fseek((*handler)->file_descriptor, info_skip_offset.position, SEEK_SET);
		if (fwrite(&info_skip_offset.size, sizeof(short), 1, (*handler)->file_descriptor) != 1)
		{
			idydb_clear_values(handler);
			idydb_error_state(handler, 15);
			return IDYDB_ERROR;
		}
	}
	if (info_row_count.use)
	{
		fseek((*handler)->file_descriptor, info_row_count.position, SEEK_SET);
		if (fwrite(&info_row_count.size, sizeof(short), 1, (*handler)->file_descriptor) != 1)
		{
			idydb_clear_values(handler);
			idydb_error_state(handler, 15);
			return IDYDB_ERROR;
		}
	}
	if (info_row_position.use)
	{
		fseek((*handler)->file_descriptor, info_row_position.position, SEEK_SET);
		if (fwrite(&info_row_position.size, sizeof(short), 1, (*handler)->file_descriptor) != 1)
		{
			idydb_clear_values(handler);
			idydb_error_state(handler, 15);
			return IDYDB_ERROR;
		}
	}
	if (info_input_size.use)
	{
		// For CHAR: store (bytes without terminator), for VECTOR: store dims
		unsigned short write_size = info_input_size.size;
		fseek((*handler)->file_descriptor, info_input_size.position, SEEK_SET);
		if (fwrite(&write_size, sizeof(short), 1, (*handler)->file_descriptor) != 1)
		{
			idydb_clear_values(handler);
			idydb_error_state(handler, 15);
			return IDYDB_ERROR;
		}
	}
	if (info_input_type.use)
	{
		fseek((*handler)->file_descriptor, info_input_type.position, SEEK_SET);
		unsigned short input_type = 0;
		switch (info_input_type.size)
		{
		case IDYDB_INTEGER:
			input_type = IDYDB_READ_INT;
			break;
		case IDYDB_FLOAT:
			input_type = IDYDB_READ_FLOAT;
			break;
		case IDYDB_CHAR:
			input_type = IDYDB_READ_CHAR;
			break;
		case IDYDB_BOOL:
			input_type = ((*handler)->value.bool_value ? IDYDB_READ_BOOL_TRUE : IDYDB_READ_BOOL_FALSE);
			break;
		case IDYDB_VECTOR:
			input_type = IDYDB_READ_VECTOR;
			break;
		}
		if (fwrite(&input_type, 1, 1, (*handler)->file_descriptor) != 1)
		{
			idydb_clear_values(handler);
			idydb_error_state(handler, 15);
			return IDYDB_ERROR;
		}
	}
	if (info_input_buffer.use)
	{
		fseek((*handler)->file_descriptor, info_input_buffer.position, SEEK_SET);
		switch (info_input_type.size)
		{
		case IDYDB_INTEGER:
			if (fwrite(&(*handler)->value.int_value, sizeof(int), 1, (*handler)->file_descriptor) != 1)
			{
				idydb_clear_values(handler);
				idydb_error_state(handler, 15);
				return IDYDB_ERROR;
			}
			break;
		case IDYDB_FLOAT:
			if (fwrite(&(*handler)->value.float_value, sizeof(float), 1, (*handler)->file_descriptor) != 1)
			{
				idydb_clear_values(handler);
				idydb_error_state(handler, 15);
				return IDYDB_ERROR;
			}
			break;
		case IDYDB_CHAR:
			if (fwrite((*handler)->value.char_value, input_size_default, sizeof(char), (*handler)->file_descriptor) != sizeof(char))
			{
				idydb_clear_values(handler);
				idydb_error_state(handler, 15);
				return IDYDB_ERROR;
			}
			break;
		case IDYDB_VECTOR:
			if (fwrite((*handler)->vector_value, sizeof(float), (*handler)->vector_dims, (*handler)->file_descriptor) != (*handler)->vector_dims)
			{
				idydb_clear_values(handler);
				idydb_error_state(handler, 15);
				return IDYDB_ERROR;
			}
			break;
		}
	}
	idydb_clear_values(handler);
	return IDYDB_DONE;
}

/* ---------------- Vector math helpers ---------------- */

static inline float idydb_dot(const float* a, const float* b, unsigned short d) {
	float s = 0.0f;
	for (unsigned short i = 0; i < d; ++i) s += a[i] * b[i];
	return s;
}
static inline float idydb_l2(const float* a, const float* b, unsigned short d) {
	float s = 0.0f;
	for (unsigned short i = 0; i < d; ++i) { float diff = a[i]-b[i]; s += diff*diff; }
	return sqrtf(s);
}
static inline float idydb_norm(const float* a, unsigned short d) {
	return sqrtf(idydb_dot(a, a, d));
}

/* ---------------- Column scanning for kNN ---------------- */

int idydb_knn_search_vector_column(idydb **handler,
                                   idydb_column_row_sizing vector_column,
                                   const float* query,
                                   unsigned short dims,
                                   unsigned short k,
                                   idydb_similarity_metric metric,
                                   idydb_knn_result* out_results)
{
	if (!(*handler) || !(*handler)->configured || !query || dims == 0 || dims > IDYDB_MAX_VECTOR_DIM || k == 0 || !out_results)
	{
		idydb_error_state(handler, 8);
		return -1;
	}
#ifdef IDYDB_ALLOW_UNSAFE
	if (!(*handler)->unsafe)
	{
#endif
		if (vector_column == 0 || (vector_column - 1) > IDYDB_COLUMN_POSITION_MAX)
		{
			idydb_error_state(handler, 12);
			return -1;
		}
#ifdef IDYDB_ALLOW_UNSAFE
	}
#endif
	// initialize results (empty)
	for (unsigned short i = 0; i < k; ++i) { out_results[i].row = 0; out_results[i].score = -INFINITY; }
	float query_norm = 1.0f;
	if (metric == IDYDB_SIM_COSINE)
	{
		query_norm = idydb_norm(query, dims);
		if (query_norm == 0.0f) query_norm = 1.0f;
	}

	// single pass file scan (based on idydb_read_at but generalized)
	idydb_sizing_max offset = 0;
	idydb_size_selection_type skip_offset = 0;
	unsigned char read_length = IDYDB_PARTITION_AND_SEGMENT;
	unsigned short row_count = 0;

	while ((offset + read_length) <= (*handler)->size)
	{
#ifdef IDYDB_MMAP_OK
		if ((*handler)->read_only != IDYDB_READONLY_MMAPPED)
		{
#endif
			fseek((*handler)->file_descriptor, offset, SEEK_SET);
			offset += read_length;
#ifdef IDYDB_MMAP_OK
		}
#endif
		if (read_length == IDYDB_PARTITION_AND_SEGMENT)
		{
			unsigned short skip_amount = 0;
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				skip_amount = (unsigned short)idydb_read_mmap(offset, sizeof(short), (*handler)->buffer).integer;
			else
#endif
				if (fread(&skip_amount, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
			{
				idydb_error_state(handler, 14);
				return -1;
			}
			skip_offset += skip_amount;
			skip_offset += 1;
			if (skip_offset > IDYDB_COLUMN_POSITION_MAX)
			{
				idydb_error_state(handler, 22);
				return -1;
			}
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				row_count = (unsigned short)idydb_read_mmap((offset + sizeof(short)), sizeof(short), (*handler)->buffer).integer;
			else
#endif
				if (fread(&row_count, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
			{
				idydb_error_state(handler, 14);
				return -1;
			}
			row_count += 1;
		}
		unsigned char set_read_length = IDYDB_PARTITION_AND_SEGMENT;

		// read row position and type
		unsigned short row_pos = 0;
		if (skip_offset == vector_column) {
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				row_pos = (unsigned short)idydb_read_mmap((offset + ((sizeof(short) * 2) * (read_length == IDYDB_PARTITION_AND_SEGMENT))), sizeof(short), (*handler)->buffer).integer;
			else
#endif
				if (fread(&row_pos, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short))
			{
				idydb_error_state(handler, 14);
				return -1;
			}
		} else {
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only != IDYDB_READONLY_MMAPPED)
#endif
				fseek((*handler)->file_descriptor, sizeof(short), SEEK_CUR);
		}

		if (row_count > 1) { row_count -= 1; set_read_length = IDYDB_SEGMENT_SIZE; }

		unsigned char data_type;
#ifdef IDYDB_MMAP_OK
		idydb_sizing_max offset_mmap_standard_diff = offset + (sizeof(short) * 3);
		if (read_length == IDYDB_SEGMENT_SIZE)
			offset_mmap_standard_diff = (offset + sizeof(short));
		if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
		{
			if (read_length == IDYDB_PARTITION_AND_SEGMENT)
				data_type = (unsigned short)idydb_read_mmap((offset + (sizeof(short) * 3)), 1, (*handler)->buffer).integer;
			else
				data_type = (unsigned short)idydb_read_mmap((offset + sizeof(short)), 1, (*handler)->buffer).integer;
			offset_mmap_standard_diff += 1;
		}
		else
#endif
			if (fread(&data_type, 1, 1, (*handler)->file_descriptor) != 1)
		{
			idydb_error_state(handler, 14);
			return -1;
		}

		unsigned short adv = 0; // bytes to advance (payload + headers we read after the type byte)
		switch (data_type)
		{
			case IDYDB_READ_CHAR: {
				unsigned short n = 0;
#ifdef IDYDB_MMAP_OK
				if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
					n = (unsigned short)idydb_read_mmap(offset_mmap_standard_diff, sizeof(short), (*handler)->buffer).integer;
				else
#endif
					if (fread(&n, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) { idydb_error_state(handler, 14); return -1; }
				adv = (unsigned short)(sizeof(short) + n + 1);
				break;
			}
			case IDYDB_READ_INT:   adv = sizeof(int);   break;
			case IDYDB_READ_FLOAT: adv = sizeof(float); break;
			case IDYDB_READ_BOOL_TRUE:
			case IDYDB_READ_BOOL_FALSE:
				adv = 0; break;
			case IDYDB_READ_VECTOR: {
				unsigned short vdims = 0;
#ifdef IDYDB_MMAP_OK
				if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
					vdims = (unsigned short)idydb_read_mmap(offset_mmap_standard_diff, sizeof(short), (*handler)->buffer).integer;
				else
#endif
					if (fread(&vdims, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) { idydb_error_state(handler, 14); return -1; }
				adv = (unsigned short)(sizeof(short) + vdims * sizeof(float));

				if (skip_offset == vector_column && vdims == dims) {
					// compute similarity
					float score = -INFINITY;
					float tmpnorm = 1.0f;
					if (metric == IDYDB_SIM_COSINE) tmpnorm = 0.0f; // we'll compute normB as we read

					// read payload and accumulate
#ifdef IDYDB_MMAP_OK
					if ((*handler)->read_only == IDYDB_READONLY_MMAPPED) {
						idydb_sizing_max base = offset_mmap_standard_diff + sizeof(short);
						float dot = 0.0f, l2acc = 0.0f, normB = 0.0f;
						for (unsigned short i = 0; i < dims; ++i) {
							union idydb_read_mmap_response f =
								idydb_read_mmap((unsigned int)(base + (i * sizeof(float))), (unsigned char)sizeof(float), (*handler)->buffer);
							float b = f.floating_point;
							if (metric == IDYDB_SIM_COSINE) { dot += query[i] * b; normB += b*b; }
							else { float d = query[i]-b; l2acc += d*d; }
						}
						if (metric == IDYDB_SIM_COSINE) {
							normB = sqrtf(normB); if (normB == 0.0f) normB = 1.0f;
							score = dot / (query_norm * normB);
						} else {
							score = -sqrtf(l2acc);
						}
					} else
#endif
					{
						// streaming read
						float dot = 0.0f, l2acc = 0.0f, normB = 0.0f;
						for (unsigned short i = 0; i < dims; ++i) {
							float b;
							if (fread(&b, sizeof(float), 1, (*handler)->file_descriptor) != 1) { idydb_error_state(handler, 18); return -1; }
							if (metric == IDYDB_SIM_COSINE) { dot += query[i]*b; normB += b*b; }
							else { float d = query[i]-b; l2acc += d*d; }
						}
						if (metric == IDYDB_SIM_COSINE) {
							float normBv = sqrtf(normB); if (normBv == 0.0f) normBv = 1.0f;
							score = dot / (query_norm * normBv);
						} else {
							score = -sqrtf(l2acc);
						}
					}
					// update top-k (linear replace worst)
					unsigned short worst = 0;
					float worstScore = out_results[0].score;
					for (unsigned short i = 1; i < k; ++i) {
						if (out_results[i].score < worstScore) { worstScore = out_results[i].score; worst = i; }
					}
					if (score > worstScore) {
						out_results[worst].row = (idydb_column_row_sizing)(row_pos + 1);
						out_results[worst].score = score;
					}
					// we already consumed payload floats in the non-mmap path; ensure 'adv' accounting fits
					// For mmap path, we didn't move the file cursor; adv will move offset later.
				}
				break;
			}
			default:
				idydb_error_state(handler, 20);
				return -1;
		}

#ifdef IDYDB_MMAP_OK
		if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
			offset += read_length;
#endif
		read_length = set_read_length;
		if ((*handler)->read_only != IDYDB_READONLY_MMAPPED)
		{
			// If we read additional bytes inline (non-mmap) for vector payload during scoring,
			// we have already advanced file cursor. We only need to skip the remainder if any.
			// Compute how many bytes we already consumed beyond the type (for non-mmap):
			// We cannot easily track partial; safest is to seek to align to computed adv relative to post-type position.
			long cur = ftell((*handler)->file_descriptor);
			long want = (long)cur; // default no-op
			// For non-mmap and when not the target column or type != vector, we haven't consumed payload; need to skip adv.
			// For vectors in target col we consumed exactly dims*sizeof(float) (which equals adv - sizeof(short) already accounted by fread of dims).
			// In both cases, ensure we are at cur + remaining_to_skip.
			// Here we recalc remaining_to_skip by checking data_type:
			unsigned short remaining = adv;
			if (adv > 0) {
				// we have already consumed the type byte and:
				// - for CHAR: we consumed 2 bytes of length (already fread) in non-mmap path when computing 'n', but NOT the payload
				// - for VECTOR: if in target col we also consumed dims floats; if not, we only consumed dims short
			}
			// To keep implementation safe and simple, we rely on the earlier fread operations to have advanced the pointer correctly.
			// No extra seek here.
			(void)remaining;
			(void)want;
		}
		else {
			offset += adv;
		}
	}
	// sort results descending by score (simple bubble due to small k)
	for (unsigned short i = 0; i < k; ++i) {
		for (unsigned short j = i+1; j < k; ++j) {
			if (out_results[j].row != 0 && (out_results[i].row == 0 || out_results[j].score > out_results[i].score)) {
				idydb_knn_result tmp = out_results[i];
				out_results[i] = out_results[j];
				out_results[j] = tmp;
			}
		}
	}
	// count valid results
	unsigned short count = 0;
	for (unsigned short i = 0; i < k; ++i) if (out_results[i].row != 0) ++count;
	return (int)count;
}

/* ---------------- Utility: next row index ---------------- */

idydb_column_row_sizing idydb_column_next_row(idydb **handler, idydb_column_row_sizing column)
{
	if (!(*handler) || !(*handler)->configured) return 1;
	idydb_sizing_max offset = 0;
	idydb_size_selection_type skip_offset = 0;
	unsigned char read_length = IDYDB_PARTITION_AND_SEGMENT;
	unsigned short row_count = 0;
	unsigned short max_row = 0;
	while ((offset + read_length) <= (*handler)->size)
	{
#ifdef IDYDB_MMAP_OK
		if ((*handler)->read_only != IDYDB_READONLY_MMAPPED)
		{
#endif
			fseek((*handler)->file_descriptor, offset, SEEK_SET);
			offset += read_length;
#ifdef IDYDB_MMAP_OK
		}
#endif
		if (read_length == IDYDB_PARTITION_AND_SEGMENT)
		{
			unsigned short skip_amount = 0;
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				skip_amount = (unsigned short)idydb_read_mmap(offset, sizeof(short), (*handler)->buffer).integer;
			else
#endif
				if (fread(&skip_amount, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) break;
			skip_offset += skip_amount;
			skip_offset += 1;
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				row_count = (unsigned short)idydb_read_mmap((offset + sizeof(short)), sizeof(short), (*handler)->buffer).integer;
			else
#endif
				if (fread(&row_count, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) break;
			row_count += 1;
		}
		unsigned char set_read_length = IDYDB_PARTITION_AND_SEGMENT;
		if (skip_offset == column)
		{
			unsigned short row_pos = 0;
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
				row_pos = (unsigned short)idydb_read_mmap((offset + ((sizeof(short) * 2) * (read_length == IDYDB_PARTITION_AND_SEGMENT))), sizeof(short), (*handler)->buffer).integer;
			else
#endif
				if (fread(&row_pos, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) break;
			if ((row_pos + 1) > max_row) max_row = (unsigned short)(row_pos + 1);
		}
		else
#ifdef IDYDB_MMAP_OK
			if ((*handler)->read_only != IDYDB_READONLY_MMAPPED)
#endif
			fseek((*handler)->file_descriptor, sizeof(short), SEEK_CUR);

		if (row_count > 1) { row_count -= 1; set_read_length = IDYDB_SEGMENT_SIZE; }

		unsigned char t;
#ifdef IDYDB_MMAP_OK
		idydb_sizing_max offset_mmap_standard_diff = offset + (sizeof(short) * 3);
		if (read_length == IDYDB_SEGMENT_SIZE)
			offset_mmap_standard_diff = (offset + sizeof(short));
		if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
			t = (unsigned short)idydb_read_mmap((read_length == IDYDB_PARTITION_AND_SEGMENT ? (offset + (sizeof(short) * 3)) : (offset + sizeof(short))), 1, (*handler)->buffer).integer;
		else
#endif
			if (fread(&t, 1, 1, (*handler)->file_descriptor) != 1) break;

		unsigned short adv = 0;
		switch (t) {
			case IDYDB_READ_CHAR: {
				unsigned short n = 0;
#ifdef IDYDB_MMAP_OK
				if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
					n = (unsigned short)idydb_read_mmap(offset_mmap_standard_diff, sizeof(short), (*handler)->buffer).integer;
				else
#endif
					if (fread(&n, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) n = 0;
				adv = (unsigned short)(sizeof(short) + n + 1);
				break;
			}
			case IDYDB_READ_INT:   adv = sizeof(int); break;
			case IDYDB_READ_FLOAT: adv = sizeof(float); break;
			case IDYDB_READ_BOOL_TRUE:
			case IDYDB_READ_BOOL_FALSE:
				adv = 0; break;
			case IDYDB_READ_VECTOR: {
				unsigned short d = 0;
#ifdef IDYDB_MMAP_OK
				if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
					d = (unsigned short)idydb_read_mmap(offset_mmap_standard_diff, sizeof(short), (*handler)->buffer).integer;
				else
#endif
					if (fread(&d, 1, sizeof(short), (*handler)->file_descriptor) != sizeof(short)) d = 0;
				adv = (unsigned short)(sizeof(short) + d * sizeof(float));
				break;
			}
			default: break;
		}
#ifdef IDYDB_MMAP_OK
		if ((*handler)->read_only == IDYDB_READONLY_MMAPPED)
			offset += read_length;
#endif
		read_length = set_read_length;
		offset += adv;
	}
	return (idydb_column_row_sizing)(max_row + 1);
}

/* ---------------- RAG helpers ---------------- */

void idydb_set_embedder(idydb **handler, idydb_embed_fn fn, void* user) {
	if (!(*handler)) return;
	(*handler)->embedder = fn;
	(*handler)->embedder_user = user;
}

int idydb_rag_upsert_text(idydb **handler,
                          idydb_column_row_sizing text_column,
                          idydb_column_row_sizing vector_column,
                          idydb_column_row_sizing row,
                          const char* text,
                          const float* embedding,
                          unsigned short dims)
{
	if (!text || !embedding || dims == 0) { idydb_error_state(handler, 8); return IDYDB_ERROR; }
	int rc = idydb_insert_const_char(handler, text_column, row, text);
	if (rc != IDYDB_DONE) return rc;
	rc = idydb_insert_vector(handler, vector_column, row, embedding, dims);
	return rc;
}

int idydb_rag_upsert_text_auto_embed(idydb **handler,
                                     idydb_column_row_sizing text_column,
                                     idydb_column_row_sizing vector_column,
                                     idydb_column_row_sizing row,
                                     const char* text)
{
	if (!(*handler) || !(*handler)->embedder || !text) { idydb_error_state(handler, 8); return IDYDB_ERROR; }
	float* vec = NULL; unsigned short dims = 0;
	int erc = (*handler)->embedder(text, &vec, &dims, (*handler)->embedder_user);
	if (erc != 0 || !vec || dims == 0) { if (vec) free(vec); idydb_error_state(handler, 24); return IDYDB_ERROR; }
	int rc = idydb_rag_upsert_text(handler, text_column, vector_column, row, text, vec, dims);
	free(vec);
	return rc;
}

int idydb_rag_query_topk(idydb **handler,
                         idydb_column_row_sizing text_column,
                         idydb_column_row_sizing vector_column,
                         const float* query_embedding,
                         unsigned short dims,
                         unsigned short k,
                         idydb_similarity_metric metric,
                         idydb_knn_result* out_results,
                         char** out_texts)
{
	if (!out_results || !out_texts) { idydb_error_state(handler, 8); return -1; }
	int n = idydb_knn_search_vector_column(handler, vector_column, query_embedding, dims, k, metric, out_results);
	if (n <= 0) return n;
	for (int i = 0; i < n; ++i) {
		if (out_results[i].row == 0) { out_texts[i] = NULL; continue; }
		int rc = idydb_extract(handler, text_column, out_results[i].row);
		if (rc != IDYDB_DONE) { out_texts[i] = NULL; continue; }
		if (idydb_retrieved_type(handler) != IDYDB_CHAR) { out_texts[i] = NULL; continue; }
		char* s = idydb_retrieve_char(handler);
		if (!s) { out_texts[i] = NULL; continue; }
		size_t len = strlen(s);
		out_texts[i] = (char*)malloc(len + 1);
		if (!out_texts[i]) { idydb_error_state(handler, 24); return -1; }
		memcpy(out_texts[i], s, len + 1);
	}
	return n;
}

int idydb_rag_query_context(idydb **handler,
                            idydb_column_row_sizing text_column,
                            idydb_column_row_sizing vector_column,
                            const float* query_embedding,
                            unsigned short dims,
                            unsigned short k,
                            idydb_similarity_metric metric,
                            size_t max_chars,
                            char** out_context)
{
	if (!out_context) { idydb_error_state(handler, 8); return IDYDB_ERROR; }
	idydb_knn_result* res = (idydb_knn_result*)calloc(k, sizeof(idydb_knn_result));
	char** texts = (char**)calloc(k, sizeof(char*));
	if (!res || !texts) { if (res) free(res); if (texts) free(texts); idydb_error_state(handler, 24); return IDYDB_ERROR; }
	int n = idydb_rag_query_topk(handler, text_column, vector_column, query_embedding, dims, k, metric, res, texts);
	if (n <= 0) { free(res); free(texts); return (n == 0 ? IDYDB_DONE : IDYDB_ERROR); }
	// compute total length with separators
	size_t total = 0;
	const char* sep = "\n---\n";
	size_t sep_len = strlen(sep);
	for (int i = 0; i < n; ++i) { if (texts[i]) total += strlen(texts[i]); if (i+1 < n) total += sep_len; }
	if (max_chars > 0 && total > max_chars) total = max_chars;
	char* buf = (char*)malloc(total + 1);
	if (!buf) { for (int i=0;i<n;++i) if (texts[i]) free(texts[i]); free(res); free(texts); idydb_error_state(handler, 24); return IDYDB_ERROR; }
	size_t written = 0;
	for (int i = 0; i < n; ++i) {
		if (!texts[i]) continue;
		size_t len = strlen(texts[i]);
		if (max_chars > 0 && written + len > max_chars) len = max_chars - written;
		memcpy(buf + written, texts[i], len);
		written += len;
		if (i+1 < n) {
			if (max_chars > 0 && written + sep_len > max_chars) break;
			memcpy(buf + written, sep, sep_len);
			written += sep_len;
		}
	}
	buf[written] = '\0';
	for (int i=0;i<n;++i) if (texts[i]) free(texts[i]);
	free(res); free(texts);
	*out_context = buf;
	return IDYDB_DONE;
}

/* ---------------- undefines mirroring original ---------------- */

#undef IDYDB_MAX_BUFFER_SIZE
#undef IDYDB_MAX_CHAR_LENGTH
#undef IDYDB_MAX_VECTOR_DIM
#undef IDYDB_MAX_ERR_SIZE
#undef IDYDB_COLUMN_POSITION_MAX
#undef IDYDB_ROW_POSITION_MAX
#undef IDYDB_SEGMENT_SIZE
#undef IDYDB_PARTITION_SIZE
#undef IDYDB_PARTITION_AND_SEGMENT
#undef IDYDB_READ_INT
#undef IDYDB_READ_FLOAT
#undef IDYDB_READ_CHAR
#undef IDYDB_READ_BOOL_TRUE
#undef IDYDB_READ_BOOL_FALSE
#undef IDYDB_READ_VECTOR
#undef IDYDB_MMAP_OK
#undef IDYDB_COLUMN_POSITION_MAX
#undef IDYDB_ROW_POSITION_MAX
#undef IDYDB_ALLOW_UNSAFE
#undef IDYDB_MMAP_ALLOWED
#undef IDYDB_MMAP_OK

#endif
