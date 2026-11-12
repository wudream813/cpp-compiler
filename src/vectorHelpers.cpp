// Linked only into C++ debug builds. All operations use the actual C++ vector
// API so allocation, object lifetime and shifting are handled by the library.
#include <vector>
#include <string>
#include <cstddef>

#if defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND)
#define DREAM_TRY try
#define DREAM_CATCH catch (...) { return -1; }
#else
// Don't risk terminating the inferior on allocation failure without exceptions.
#define DREAM_TRY if (false)
#define DREAM_CATCH return -3;
#endif

template <class T>
static int dream_vector_insert(void* object, unsigned long long index, T value) noexcept {
  DREAM_TRY {
    std::vector<T>& v = *static_cast<std::vector<T>*>(object);
    if (index > v.size()) return -2;
    if (index == v.size()) v.push_back(value);
    else v.insert(v.begin() + static_cast<typename std::vector<T>::difference_type>(index), value);
    return 0;
  } DREAM_CATCH
  return -3;
}
template <class T>
static int dream_vector_erase(void* object, unsigned long long index) noexcept {
  DREAM_TRY {
    std::vector<T>& v = *static_cast<std::vector<T>*>(object);
    if (index >= v.size()) return -2;
    v.erase(v.begin() + static_cast<typename std::vector<T>::difference_type>(index));
    return 0;
  } DREAM_CATCH
  return -3;
}
#define DREAM_VECTOR_HELPER(NAME, TYPE) \
  extern "C" { \
    unsigned long long dream_debug_vector_size_##NAME = sizeof(std::vector<TYPE>); \
    unsigned long long dream_debug_element_size_##NAME = sizeof(TYPE); \
    int dream_debug_vector_insert_##NAME(void* p, unsigned long long i, TYPE v) noexcept { \
      return dream_vector_insert<TYPE>(p, i, v); \
    } \
    int dream_debug_vector_erase_##NAME(void* p, unsigned long long i) noexcept { \
      return dream_vector_erase<TYPE>(p, i); \
    } \
  }
DREAM_VECTOR_HELPER(char, char)
DREAM_VECTOR_HELPER(schar, signed char)
DREAM_VECTOR_HELPER(uchar, unsigned char)
DREAM_VECTOR_HELPER(short, short)
DREAM_VECTOR_HELPER(ushort, unsigned short)
DREAM_VECTOR_HELPER(int, int)
DREAM_VECTOR_HELPER(uint, unsigned int)
DREAM_VECTOR_HELPER(long, long)
DREAM_VECTOR_HELPER(ulong, unsigned long)
DREAM_VECTOR_HELPER(llong, long long)
DREAM_VECTOR_HELPER(ullong, unsigned long long)
DREAM_VECTOR_HELPER(float, float)
DREAM_VECTOR_HELPER(double, double)

extern "C" {
unsigned long long dream_debug_vector_size_string = sizeof(std::vector<std::string>);
unsigned long long dream_debug_element_size_string = sizeof(std::string);
}
extern "C" int dream_debug_vector_insert_string(void* p, unsigned long long i, const char* bytes, unsigned long long size) noexcept {
  DREAM_TRY {
    auto& v = *static_cast<std::vector<std::string>*>(p);
    if (i > v.size()) return -2;
    std::string value(bytes, static_cast<std::size_t>(size));
    if (i == v.size()) v.push_back(value);
    else v.insert(v.begin() + static_cast<std::vector<std::string>::difference_type>(i), value);
    return 0;
  } DREAM_CATCH
  return -3;
}

extern "C" int dream_debug_vector_erase_string(void* p, unsigned long long i) noexcept {
  return dream_vector_erase<std::string>(p, i);
}

// std::string uses byte indexes (including embedded NUL bytes).
extern "C" {
unsigned long long dream_debug_string_object_size = sizeof(std::string);
int dream_debug_string_insert(void* object, unsigned long long index, const char* bytes, unsigned long long size) noexcept {
  DREAM_TRY {
    auto& str = *static_cast<std::string*>(object);
    if (index > str.size()) return -2;
    str.insert(static_cast<std::size_t>(index), bytes, static_cast<std::size_t>(size));
    return 0;
  } DREAM_CATCH
  return -3;
}
int dream_debug_string_erase(void* object, unsigned long long index) noexcept {
  DREAM_TRY {
    auto& str = *static_cast<std::string*>(object);
    if (index >= str.size()) return -2;
    str.erase(static_cast<std::size_t>(index), 1);
    return 0;
  } DREAM_CATCH
  return -3;
}
}
