import argparse
import base64
from io import BytesIO
import json
import os
import sys

import cv2
import face_recognition
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError


DEFAULT_TOLERANCE = 0.6
MAX_IMAGE_PIXELS = 20_000_000
MAX_DETECTION_DIMENSION = 1600
MIN_IMAGE_DIMENSION = 80
MIN_LIVE_FACE_AREA_RATIO = 0.05
MIN_REFERENCE_FACE_AREA_RATIO = 0.01
MIN_FACE_BRIGHTNESS = 35.0
MAX_FACE_BRIGHTNESS = 245.0
MIN_BLUR_VARIANCE = 25.0


def empty_result():
    return {
        "success": True,
        "verified": False,
        "code": "FACE_MISMATCH",
        "distance": None,
        "threshold": DEFAULT_TOLERANCE,
        "message": "Face verification failed.",
        "reference_face_count": 0,
        "live_face_count": 0,
    }


def image_bytes(image_input):
    if isinstance(image_input, bytes):
        return image_input

    if image_input.startswith("data:image"):
        try:
            _, encoded = image_input.split(",", 1)
            return base64.b64decode(encoded, validate=True)
        except (ValueError, base64.binascii.Error) as error:
            raise ValueError("The camera image could not be decoded.") from error

    if os.path.isfile(image_input):
        with open(image_input, "rb") as image_file:
            return image_file.read()

    raise ValueError("The registered profile image could not be found.")


def decode_image(image_input):
    data = image_bytes(image_input)
    if not data:
        raise ValueError("The image is empty.")

    try:
        with Image.open(BytesIO(data)) as image:
            if image.format not in {"JPEG", "PNG"}:
                raise ValueError("Only JPEG and PNG images are supported.")

            width, height = image.size
            if width < MIN_IMAGE_DIMENSION or height < MIN_IMAGE_DIMENSION:
                raise ValueError("The image resolution is too small for face verification.")
            if width * height > MAX_IMAGE_PIXELS:
                raise ValueError("The image resolution is too large for face verification.")

            corrected = ImageOps.exif_transpose(image).convert("RGB")
            rgb_image = np.asarray(corrected)
    except (UnidentifiedImageError, OSError) as error:
        raise ValueError("The image is not a valid JPEG or PNG file.") from error

    max_dimension = max(rgb_image.shape[:2])
    if max_dimension > MAX_DETECTION_DIMENSION:
        scale = MAX_DETECTION_DIMENSION / max_dimension
        rgb_image = cv2.resize(
            rgb_image,
            (int(rgb_image.shape[1] * scale), int(rgb_image.shape[0] * scale)),
            interpolation=cv2.INTER_AREA,
        )

    return np.ascontiguousarray(rgb_image)


def face_quality_message(rgb_image, location):
    top, right, bottom, left = location
    face_crop = rgb_image[max(0, top):bottom, max(0, left):right]
    if face_crop.size == 0:
        return "Unable to verify face clearly. Please improve lighting and try again."

    gray_face = cv2.cvtColor(face_crop, cv2.COLOR_RGB2GRAY)
    brightness = float(np.mean(gray_face))
    blur_variance = float(cv2.Laplacian(gray_face, cv2.CV_64F).var())

    if brightness < MIN_FACE_BRIGHTNESS:
        return "Unable to verify face clearly. Please improve the lighting and try again."
    if brightness > MAX_FACE_BRIGHTNESS:
        return "Unable to verify face clearly. Please avoid strong backlighting and try again."
    if blur_variance < MIN_BLUR_VARIANCE:
        return "Unable to verify face clearly. Hold still, focus the camera, and try again."

    return None


def analyze_face(rgb_image, label, minimum_area_ratio):
    locations = face_recognition.face_locations(
        rgb_image,
        number_of_times_to_upsample=1,
        model="hog",
    )
    if not locations:
        locations = face_recognition.face_locations(
            rgb_image,
            number_of_times_to_upsample=2,
            model="hog",
        )

    face_count = len(locations)
    if face_count == 0:
        if label == "live":
            return None, face_count, "NO_LIVE_FACE", "No face detected. Please face the camera clearly."
        return None, face_count, "NO_REFERENCE_FACE", "No usable face was detected in the registered profile image. Please contact the organizer."

    if face_count > 1:
        if label == "live":
            return None, face_count, "MULTIPLE_LIVE_FACES", "Multiple faces detected. Please ensure only one person is visible."
        return None, face_count, "MULTIPLE_REFERENCE_FACES", "Multiple faces were detected in the registered profile image. Please contact the organizer."

    location = locations[0]
    top, right, bottom, left = location
    face_area = max(0, right - left) * max(0, bottom - top)
    image_area = rgb_image.shape[0] * rgb_image.shape[1]
    face_area_ratio = face_area / image_area if image_area else 0.0
    if face_area_ratio < minimum_area_ratio:
        if label == "live":
            message = "Unable to verify face clearly. Move closer to the camera and try again."
        else:
            message = "The face in the registered profile image is too small. Please contact the organizer."
        return None, face_count, "POOR_IMAGE", message

    quality_error = face_quality_message(rgb_image, location)
    if quality_error:
        return None, face_count, "POOR_IMAGE", quality_error

    encodings = face_recognition.face_encodings(
        rgb_image,
        known_face_locations=locations,
        num_jitters=1,
        model="small",
    )
    if len(encodings) != 1:
        return None, face_count, "POOR_IMAGE", "Unable to verify face clearly. Please improve lighting and try again."

    return encodings[0], face_count, None, None


def compare(reference_input, live_input, tolerance=DEFAULT_TOLERANCE):
    result = empty_result()
    result["threshold"] = tolerance

    try:
        reference_image = decode_image(reference_input)
    except ValueError as error:
        result.update(
            success=False,
            code="INVALID_REFERENCE_IMAGE",
            message=str(error),
        )
        return result

    try:
        live_image = decode_image(live_input)
    except ValueError as error:
        result.update(
            code="INVALID_LIVE_IMAGE",
            message=str(error),
        )
        return result

    reference_encoding, reference_count, error_code, error_message = analyze_face(
        reference_image,
        "reference",
        MIN_REFERENCE_FACE_AREA_RATIO,
    )
    result["reference_face_count"] = reference_count
    if error_code:
        result.update(code=error_code, message=error_message)
        return result

    live_encoding, live_count, error_code, error_message = analyze_face(
        live_image,
        "live",
        MIN_LIVE_FACE_AREA_RATIO,
    )
    result["live_face_count"] = live_count
    if error_code:
        result.update(code=error_code, message=error_message)
        return result

    distance = float(face_recognition.face_distance([reference_encoding], live_encoding)[0])
    verified = bool(face_recognition.compare_faces(
        [reference_encoding],
        live_encoding,
        tolerance=tolerance,
    )[0])

    result.update(
        verified=verified,
        code="FACE_VERIFIED" if verified else "FACE_MISMATCH",
        distance=round(distance, 4),
        message=(
            "Face verified successfully."
            if verified
            else "Face verification failed. Please make sure the registered candidate is in front of the camera."
        ),
    )
    return result


def main():
    parser = argparse.ArgumentParser(description="Compare one registered face with one live camera image.")
    parser.add_argument("--ref", required=True, help="Path to the registered candidate image")
    live_group = parser.add_mutually_exclusive_group(required=True)
    live_group.add_argument("--live", help="Live image path or base64 data URI")
    live_group.add_argument(
        "--live-stdin",
        action="store_true",
        help="Read the live image bytes from standard input",
    )
    parser.add_argument(
        "--tolerance",
        type=float,
        default=DEFAULT_TOLERANCE,
        help="Face distance tolerance (face_recognition default: 0.6)",
    )
    args = parser.parse_args()

    if not 0.0 < args.tolerance < 1.0:
        print(json.dumps({
            **empty_result(),
            "success": False,
            "code": "INVALID_CONFIGURATION",
            "message": "Face verification is not configured correctly.",
        }))
        return

    live_input = sys.stdin.buffer.read() if args.live_stdin else args.live

    try:
        verification_result = compare(args.ref, live_input, args.tolerance)
    except Exception:
        verification_result = empty_result()
        verification_result.update(
            success=False,
            code="SERVICE_ERROR",
            message="Unable to complete face verification. Please try again.",
        )

    print(json.dumps(verification_result))


if __name__ == "__main__":
    main()
