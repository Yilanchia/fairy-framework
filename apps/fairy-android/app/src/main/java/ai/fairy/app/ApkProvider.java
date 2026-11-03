package ai.fairy.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * The downloaded APK has to reach the system installer, and since Android 7 that means a content
 * URI rather than a file path. This is the smallest provider that can do it: one file, no queries.
 */
public class ApkProvider extends ContentProvider {
  private static final String AUTHORITY = "ai.fairy.app.apk";

  static Uri uriFor(File apk) {
    return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(apk.getName()).build();
  }

  @Override
  public boolean onCreate() {
    return true;
  }

  @Override
  public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    File file = new File(getContext().getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS), uri.getLastPathSegment());
    if (!file.exists()) throw new FileNotFoundException(uri.toString());
    return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override
  public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
    return null;
  }

  @Override
  public String getType(Uri uri) {
    return "application/vnd.android.package-archive";
  }

  @Override
  public Uri insert(Uri uri, ContentValues values) {
    return null;
  }

  @Override
  public int delete(Uri uri, String selection, String[] selectionArgs) {
    return 0;
  }

  @Override
  public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
    return 0;
  }
}
