fun map(e: Throwable) = when (e) { is IOException -> LCommon.networkError; else -> null }
